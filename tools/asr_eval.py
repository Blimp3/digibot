"""Offline ASR quality scoring from strict JSONL records.

This tool consumes JSONL metadata and already-produced hypotheses. It never
invokes an ASR engine or accesses a network.
"""

from __future__ import annotations

import argparse
import json
import math
import random
import re
import sys
import unicodedata
from collections import Counter
from collections.abc import Mapping, Sequence
from pathlib import Path
from statistics import quantiles
from typing import Any

OK_STATUSES = frozenset({"no_speech", "ok"})
FAILURE_STATUSES = frozenset(
    {"cancelled", "error", "failed", "processing_failure", "timeout"}
)
NO_SPEECH_CLASSES = (
    "empty",
    "punctuation_or_symbol_only",
    "non_speech_annotation",
    "lexical_output",
    "processing_failure",
)
SPLITS = frozenset({"calibration", "heldout", "non_speech"})
_LANGUAGE_RE = re.compile(r"^[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{2,8})*$")
_STRATUM_RE = re.compile(r"^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$")
_APOSTROPHE_TRANSLATION = str.maketrans({"\u2018": "'", "\u2019": "'"})
BOOTSTRAP_REPLICATES = 1_000
BOOTSTRAP_SEED = 20_260_908
_ANNOTATION_TERMS = frozenset(
    {
        "applause",
        "applausi",
        "background music",
        "background noise",
        "blank audio",
        "breath",
        "breathing",
        "cough",
        "coughing",
        "inaudible",
        "incomprehensible",
        "incomprensibile",
        "laughing",
        "laughter",
        "music",
        "musica",
        "no speech",
        "noise",
        "risata",
        "silence",
        "silenzio",
        "singing",
        "sneeze",
        "sneezing",
        "speaking foreign language",
        "unintelligible",
    }
)
_UNKNOWN_SPEAKERS = frozenset(
    {"", "na", "n/a", "none", "null", "unk", "unknown", "unspecified"}
)


class SchemaError(ValueError):
    """Raised when an input record is incomplete, ambiguous, or malformed."""


def _object(
    value: Any, path: str, required: set[str], optional: set[str] | None = None
) -> dict[str, Any]:
    if not isinstance(value, Mapping):
        raise SchemaError(f"{path}: expected an object")
    optional = optional or set()
    record = dict(value)
    unknown = set(record) - required - optional
    if unknown:
        raise SchemaError(f"{path}: unknown field(s): {', '.join(sorted(unknown))}")
    missing = required - set(record)
    if missing:
        raise SchemaError(f"{path}: missing field(s): {', '.join(sorted(missing))}")
    return record


def _string(value: Any, path: str, *, empty: bool = False, trim: bool = False) -> str:
    if not isinstance(value, str):
        raise SchemaError(f"{path}: expected a string")
    try:
        value.encode("utf-8")
    except UnicodeEncodeError as exc:
        raise SchemaError(f"{path}: invalid Unicode") from exc
    if not empty and not value.strip():
        raise SchemaError(f"{path}: must not be empty")
    if trim and value != value.strip():
        raise SchemaError(f"{path}: surrounding whitespace is not allowed")
    return value


def _number(value: Any, path: str) -> float:
    if isinstance(value, bool) or not isinstance(value, int | float):
        raise SchemaError(f"{path}: expected a finite number")
    try:
        number = float(value)
    except (OverflowError, ValueError) as exc:
        raise SchemaError(f"{path}: expected a finite number") from exc
    if not math.isfinite(number):
        raise SchemaError(f"{path}: expected a finite number")
    return number


def _language(value: Any, path: str) -> str:
    language = _string(value, path, trim=True)
    if not _LANGUAGE_RE.fullmatch(language):
        raise SchemaError(f"{path}: expected a BCP-47-like language tag")
    return language.replace("_", "-").casefold()


def _provenance(value: Any, path: str) -> dict[str, Any]:
    record = _object(value, path, {"sha256", "license", "source", "revision", "crop"})
    sha256 = _string(record["sha256"], f"{path}.sha256", trim=True)
    if not re.fullmatch(r"[0-9A-Fa-f]{64}", sha256):
        raise SchemaError(f"{path}.sha256: expected 64 hexadecimal characters")
    crop = _object(record["crop"], f"{path}.crop", {"start_s", "end_s"})
    start_s = _number(crop["start_s"], f"{path}.crop.start_s")
    end_s = _number(crop["end_s"], f"{path}.crop.end_s")
    if start_s < 0 or end_s <= start_s:
        raise SchemaError(f"{path}.crop: require 0 <= start_s < end_s")
    return {
        "sha256": sha256.casefold(),
        "license": _string(record["license"], f"{path}.license", trim=True),
        "source": _string(record["source"], f"{path}.source", trim=True),
        "revision": _string(record["revision"], f"{path}.revision", trim=True),
        "crop": {"start_s": start_s, "end_s": end_s},
    }


def normalize_text(text: str) -> str:
    """NFC, casefold, canonical apostrophes, and whitespace collapse."""

    normalized = unicodedata.normalize("NFC", text).casefold()
    return " ".join(normalized.translate(_APOSTROPHE_TRANSLATION).split())


def normalize_lexical_text(text: str) -> str:
    """Remove sentence punctuation while retaining lexical and numeric meaning."""

    text = normalize_text(text)
    result = []
    for index, character in enumerate(text):
        previous = text[index - 1] if index else ""
        following = text[index + 1] if index + 1 < len(text) else ""
        lexical = character.isalnum() or unicodedata.category(character).startswith("M")
        apostrophe = character == "'" and previous.isalnum() and following.isalnum()
        numeric_sign = (
            character in "+-\u2212" and following.isdigit() and not previous.isalnum()
        )
        decimal_separator = (
            character in ".," and previous.isdigit() and following.isdigit()
        )
        result.append(
            character
            if lexical or apostrophe or numeric_sign or decimal_separator
            else " "
        )
    return " ".join("".join(result).split())


def _forms(value: Any, path: str) -> list[str]:
    if not isinstance(value, list) or not value:
        raise SchemaError(f"{path}: expected a non-empty list")
    forms = [_string(item, f"{path}[{index}]") for index, item in enumerate(value)]
    if all(not normalize_text(form) for form in forms):
        raise SchemaError(f"{path}: at least one form must contain text")
    return forms


def _criteria(value: Any, path: str) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        raise SchemaError(f"{path}: expected a list")
    result = []
    seen: set[str] = set()
    for index, item in enumerate(value):
        item_path = f"{path}[{index}]"
        record = _object(item, item_path, {"id", "accepted_forms"})
        criterion_id = _string(record["id"], f"{item_path}.id", trim=True)
        if criterion_id in seen:
            raise SchemaError(f"{item_path}.id: duplicate id {criterion_id!r}")
        seen.add(criterion_id)
        result.append(
            {
                "id": criterion_id,
                "accepted_forms": _forms(
                    record["accepted_forms"], f"{item_path}.accepted_forms"
                ),
            }
        )
    return result


def _anchors(value: Any, path: str) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        raise SchemaError(f"{path}: expected a list")
    result = []
    seen: set[str] = set()
    for index, item in enumerate(value):
        item_path = f"{path}[{index}]"
        record = _object(item, item_path, {"id", "start_s", "end_s", "accepted_forms"})
        anchor_id = _string(record["id"], f"{item_path}.id", trim=True)
        if anchor_id in seen:
            raise SchemaError(f"{item_path}.id: duplicate id {anchor_id!r}")
        seen.add(anchor_id)
        start_s = _number(record["start_s"], f"{item_path}.start_s")
        end_s = _number(record["end_s"], f"{item_path}.end_s")
        if start_s < 0 or end_s <= start_s:
            raise SchemaError(f"{item_path}: require 0 <= start_s < end_s")
        result.append(
            {
                "id": anchor_id,
                "start_s": start_s,
                "end_s": end_s,
                "accepted_forms": _forms(
                    record["accepted_forms"], f"{item_path}.accepted_forms"
                ),
            }
        )
    return result


def _validate_reference(value: Any, index: int) -> dict[str, Any]:
    path = f"references[{index}]"
    record = _object(
        value,
        path,
        {"clip_id", "language", "stratum", "speaker", "split", "text", "provenance"},
        {"critical", "anchors"},
    )
    stratum = _string(record["stratum"], f"{path}.stratum", trim=True)
    if not _STRATUM_RE.fullmatch(stratum):
        raise SchemaError(f"{path}.stratum: expected a lower_snake_case identifier")
    split = _string(record["split"], f"{path}.split", trim=True)
    if split not in SPLITS:
        raise SchemaError(f"{path}.split: expected one of {', '.join(sorted(SPLITS))}")
    return {
        "clip_id": _string(record["clip_id"], f"{path}.clip_id", trim=True),
        "language": _language(record["language"], f"{path}.language"),
        "stratum": stratum,
        "speaker": _string(record["speaker"], f"{path}.speaker", trim=True),
        "split": split,
        "text": _string(record["text"], f"{path}.text", empty=True),
        "provenance": _provenance(record["provenance"], f"{path}.provenance"),
        "critical": _criteria(record.get("critical", []), f"{path}.critical"),
        "anchors": _anchors(record.get("anchors", []), f"{path}.anchors"),
    }


def _validate_segment(value: Any, path: str) -> dict[str, Any]:
    record = _object(value, path, {"start_s", "end_s", "text"})
    start_s = _number(record["start_s"], f"{path}.start_s")
    end_s = _number(record["end_s"], f"{path}.end_s")
    if start_s < 0 or end_s <= start_s:
        raise SchemaError(f"{path}: require 0 <= start_s < end_s")
    return {
        "start_s": start_s,
        "end_s": end_s,
        "text": _string(record["text"], f"{path}.text"),
    }


def _validate_hypothesis(value: Any, index: int) -> dict[str, Any]:
    path = f"hypotheses[{index}]"
    record = _object(value, path, {"clip_id", "status", "text", "segments"})
    status = _string(record["status"], f"{path}.status", trim=True)
    if status not in OK_STATUSES | FAILURE_STATUSES:
        allowed = ", ".join(sorted(OK_STATUSES | FAILURE_STATUSES))
        raise SchemaError(f"{path}.status: expected one of {allowed}")
    text = _string(record["text"], f"{path}.text", empty=True)
    raw_segments = record["segments"]
    if not isinstance(raw_segments, list):
        raise SchemaError(f"{path}.segments: expected a list")
    segments = [
        _validate_segment(item, f"{path}.segments[{index}]")
        for index, item in enumerate(raw_segments)
    ]
    for previous, current in zip(segments, segments[1:], strict=False):
        if current["start_s"] < previous["start_s"]:
            raise SchemaError(f"{path}.segments: timestamps must be ordered by start_s")
    if status == "no_speech" and (text or segments):
        raise SchemaError(f"{path}: no_speech requires empty text and segments")
    if status == "ok" and normalize_text(text) != normalize_text(
        " ".join(segment["text"] for segment in segments)
    ):
        raise SchemaError(f"{path}: ok text must match joined segment text")
    return {
        "clip_id": _string(record["clip_id"], f"{path}.clip_id", trim=True),
        "status": status,
        "text": text,
        "segments": segments,
    }


def validate_records(
    references: Sequence[Any], hypotheses: Sequence[Any]
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Validate both JSONL record sets and require an exact clip-id match."""

    if not references or not hypotheses:
        raise SchemaError("references and hypotheses must both be non-empty")
    refs = [_validate_reference(item, index) for index, item in enumerate(references)]
    hyps = [_validate_hypothesis(item, index) for index, item in enumerate(hypotheses)]
    ref_ids = [item["clip_id"] for item in refs]
    hyp_ids = [item["clip_id"] for item in hyps]
    if len(set(ref_ids)) != len(ref_ids):
        raise SchemaError("references: duplicate clip_id")
    if len(set(hyp_ids)) != len(hyp_ids):
        raise SchemaError("hypotheses: duplicate clip_id")
    ref_set, hyp_set = set(ref_ids), set(hyp_ids)
    if ref_set != hyp_set:
        missing = ", ".join(sorted(ref_set - hyp_set)) or "none"
        unmatched = ", ".join(sorted(hyp_set - ref_set)) or "none"
        raise SchemaError(
            f"clip_id sets differ; missing hypotheses: {missing}; unmatched hypotheses: {unmatched}"
        )
    return refs, hyps


def _reject_duplicate_pairs(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise SchemaError(f"duplicate object key: {key!r}")
        result[key] = value
    return result


def load_jsonl(path: str | Path) -> list[dict[str, Any]]:
    path = Path(path)
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError as exc:
        raise SchemaError(f"cannot read {path}: {exc}") from exc
    if not lines:
        raise SchemaError(f"{path}: expected at least one JSON line")
    records = []
    for line_number, line in enumerate(lines, start=1):
        if not line.strip():
            raise SchemaError(f"{path}:{line_number}: blank lines are not allowed")
        try:
            value = json.loads(line, object_pairs_hook=_reject_duplicate_pairs)
        except SchemaError as exc:
            raise SchemaError(f"{path}:{line_number}: {exc}") from exc
        except json.JSONDecodeError as exc:
            raise SchemaError(f"{path}:{line_number}: {exc}") from exc
        if not isinstance(value, Mapping):
            raise SchemaError(f"{path}:{line_number}: expected an object")
        records.append(dict(value))
    return records


def _edit_distance(
    reference: Sequence[str], hypothesis: Sequence[str]
) -> tuple[int, int, int, int]:
    """Return standard (errors, substitutions, deletions, insertions)."""

    previous = [(index, 0, 0, index) for index in range(len(hypothesis) + 1)]
    for reference_index, reference_unit in enumerate(reference, start=1):
        current = [(reference_index, 0, reference_index, 0)]
        for hypothesis_index, hypothesis_unit in enumerate(hypothesis, start=1):
            changed = int(reference_unit != hypothesis_unit)
            substitution_base = previous[hypothesis_index - 1]
            substitution = (
                substitution_base[0] + changed,
                substitution_base[1] + changed,
                substitution_base[2],
                substitution_base[3],
            )
            deletion_base = previous[hypothesis_index]
            deletion = (
                deletion_base[0] + 1,
                deletion_base[1],
                deletion_base[2] + 1,
                deletion_base[3],
            )
            insertion_base = current[hypothesis_index - 1]
            insertion = (
                insertion_base[0] + 1,
                insertion_base[1],
                insertion_base[2],
                insertion_base[3] + 1,
            )
            current.append(
                min(
                    (substitution, deletion, insertion),
                    key=lambda item: (item[0], item[2], item[3], item[1]),
                )
            )
        previous = current
    return previous[-1]


def _metrics(
    reference: Sequence[str], hypothesis: Sequence[str], rate_name: str
) -> dict[str, Any]:
    errors, substitutions, deletions, insertions = _edit_distance(reference, hypothesis)
    count = len(reference)
    return {
        "reference_units": count,
        "substitutions": substitutions,
        "deletions": deletions,
        "insertions": insertions,
        "errors": errors,
        rate_name: None if count == 0 else errors / count,
    }


def _text_metrics(
    reference: str, hypothesis: str
) -> tuple[dict[str, Any], dict[str, Any]]:
    reference = normalize_lexical_text(reference)
    hypothesis = normalize_lexical_text(hypothesis)
    return _metrics(reference.split(), hypothesis.split(), "wer"), _metrics(
        list(reference), list(hypothesis), "cer"
    )


def _word_char(value: str) -> bool:
    return value.isalnum() or value == "_"


def _numeric_continuation(text: str, position: int, *, left: bool) -> bool:
    """Treat signs and decimal separators as numeric boundaries when adjacent."""

    if left:
        if position == 0:
            return False
        character = text[position - 1]
        neighbor = text[position - 2] if position > 1 else ""
    else:
        if position == len(text):
            return False
        character = text[position]
        neighbor = text[position + 1] if position + 1 < len(text) else ""
    if character.isdigit() or character in "+-−":
        return True
    return character in ".," and neighbor.isdigit()


def _contains(text: str, form: str) -> bool:
    form = normalize_text(form)
    if not form:
        return False
    numeric = any(character.isdigit() for character in form)
    start = 0
    while (position := text.find(form, start)) >= 0:
        end = position + len(form)
        word_boundaries = (position == 0 or not _word_char(text[position - 1])) and (
            end == len(text) or not _word_char(text[end])
        )
        numeric_boundaries = not numeric or (
            not _numeric_continuation(text, position, left=True)
            and not _numeric_continuation(text, end, left=False)
        )
        if word_boundaries and numeric_boundaries:
            return True
        start = position + 1
    return False


def _criterion_results(
    criteria: list[dict[str, Any]], text: str
) -> list[dict[str, Any]]:
    normalized = normalize_text(text)
    results = []
    for criterion in criteria:
        matched_form = next(
            (
                form
                for form in criterion["accepted_forms"]
                if _contains(normalized, form)
            ),
            None,
        )
        results.append(
            {
                "id": criterion["id"],
                "accepted_forms": criterion["accepted_forms"],
                "matched": matched_form is not None,
                "matched_form": matched_form,
            }
        )
    return results


def _anchor_results(
    anchors: list[dict[str, Any]], hypothesis: dict[str, Any]
) -> list[dict[str, Any]]:
    segments = hypothesis["segments"] if hypothesis["status"] in OK_STATUSES else []
    results = []
    for anchor in anchors:
        selected = [
            segment
            for segment in segments
            if segment["end_s"] > anchor["start_s"]
            and segment["start_s"] < anchor["end_s"]
        ]
        selected.sort(
            key=lambda segment: (segment["start_s"], segment["end_s"], segment["text"])
        )
        text = normalize_text(" ".join(segment["text"] for segment in selected))
        matched_form = next(
            (form for form in anchor["accepted_forms"] if _contains(text, form)), None
        )
        results.append(
            {
                "id": anchor["id"],
                "start_s": anchor["start_s"],
                "end_s": anchor["end_s"],
                "accepted_forms": anchor["accepted_forms"],
                "segments_considered": len(selected),
                "matched": matched_form is not None,
                "matched_form": matched_form,
            }
        )
    return results


def _annotation_only(text: str) -> bool:
    stripped = text.strip()
    closing = {"[": "]", "(": ")", "{": "}", "<": ">"}
    if len(stripped) < 2 or closing.get(stripped[0]) != stripped[-1]:
        return False
    body = re.sub(r"[_-]+", " ", normalize_text(stripped[1:-1]))
    return body in _ANNOTATION_TERMS


def classify_no_speech(text: str, status: str) -> str:
    """Classify raw output for an empty reference before punctuation cleanup."""

    if status in FAILURE_STATUSES:
        return "processing_failure"
    if not text.strip():
        return "empty"
    if _annotation_only(text):
        return "non_speech_annotation"
    if all(not character.isalnum() for character in text if not character.isspace()):
        return "punctuation_or_symbol_only"
    return "lexical_output"


def _score(reference: dict[str, Any], hypothesis: dict[str, Any]) -> dict[str, Any]:
    effective_text = hypothesis["text"] if hypothesis["status"] in OK_STATUSES else ""
    word, char = _text_metrics(reference["text"], effective_text)
    empty_reference = not reference["text"].strip()
    return {
        "reference": reference,
        "hypothesis": hypothesis,
        "word": word,
        "char": char,
        "no_speech": classify_no_speech(hypothesis["text"], hypothesis["status"])
        if empty_reference
        else None,
        "critical": _criterion_results(reference["critical"], effective_text),
        "anchors": _anchor_results(reference["anchors"], hypothesis),
    }


def _sum_metric(
    scores: Sequence[dict[str, Any]], name: str, rate_name: str
) -> dict[str, Any]:
    keys = ("reference_units", "substitutions", "deletions", "insertions", "errors")
    result = {key: sum(score[name][key] for score in scores) for key in keys}
    result[rate_name] = (
        None
        if result["reference_units"] == 0
        else result["errors"] / result["reference_units"]
    )
    return result


def _summary(scores: Sequence[dict[str, Any]]) -> dict[str, Any]:
    return {
        "cases": len(scores),
        "failed_cases": sum(
            score["hypothesis"]["status"] in FAILURE_STATUSES for score in scores
        ),
        "empty_reference_cases": sum(
            score["no_speech"] is not None for score in scores
        ),
        "word": _sum_metric(scores, "word", "wer"),
        "char": _sum_metric(scores, "char", "cer"),
    }


def _criteria_summary(scores: Sequence[dict[str, Any]], name: str) -> dict[str, Any]:
    by_id: dict[str, dict[str, int]] = {}
    for score in scores:
        for result in score[name]:
            item = by_id.setdefault(result["id"], {"total": 0, "matched": 0})
            item["total"] += 1
            item["matched"] += int(result["matched"])
    for item in by_id.values():
        item["pass_rate"] = item["matched"] / item["total"] if item["total"] else None
    total = sum(item["total"] for item in by_id.values())
    matched = sum(item["matched"] for item in by_id.values())
    return {
        "total": total,
        "matched": matched,
        "pass_rate": matched / total if total else None,
        "by_id": by_id,
    }


def _view(
    all_scores: Sequence[dict[str, Any]], selected: Sequence[dict[str, Any]]
) -> dict[str, Any]:
    selected_ids = {score["reference"]["clip_id"] for score in selected}
    by_language: dict[str, list[dict[str, Any]]] = {}
    by_stratum: dict[str, list[dict[str, Any]]] = {}
    for score in selected:
        by_language.setdefault(score["reference"]["language"], []).append(score)
        by_stratum.setdefault(score["reference"]["stratum"], []).append(score)
    by_clip = {
        score["reference"]["clip_id"]: {
            "included": score["reference"]["clip_id"] in selected_ids,
            "language": score["reference"]["language"],
            "stratum": score["reference"]["stratum"],
            "speaker": score["reference"]["speaker"],
            "split": score["reference"]["split"],
            "metrics": _summary([score])
            if score["reference"]["clip_id"] in selected_ids
            else None,
        }
        for score in all_scores
    }
    no_speech = Counter(score["no_speech"] for score in selected if score["no_speech"])
    return {
        "overall": _summary(selected),
        "by_language": {key: _summary(by_language[key]) for key in sorted(by_language)},
        "by_stratum": {key: _summary(by_stratum[key]) for key in sorted(by_stratum)},
        "by_clip": by_clip,
        "no_speech": {name: no_speech.get(name, 0) for name in NO_SPEECH_CLASSES},
        "critical": _criteria_summary(selected, "critical"),
        "anchors": _criteria_summary(selected, "anchors"),
    }


def _paired_rate_difference(
    pairs: Sequence[tuple[dict[str, Any], dict[str, Any]]], metric: str
) -> float | None:
    reference_units = sum(candidate[metric]["reference_units"] for candidate, _ in pairs)
    if not reference_units:
        return None
    candidate_errors = sum(candidate[metric]["errors"] for candidate, _ in pairs)
    baseline_errors = sum(baseline[metric]["errors"] for _, baseline in pairs)
    return (candidate_errors - baseline_errors) / reference_units


def _bootstrap_language(
    pairs: Sequence[tuple[dict[str, Any], dict[str, Any]]]
) -> dict[str, Any]:
    unknown = [
        candidate["reference"]["clip_id"]
        for candidate, _ in pairs
        if candidate["reference"]["speaker"].casefold() in _UNKNOWN_SPEAKERS
    ]
    if unknown:
        return {
            "available": False,
            "reason": "requires a known speaker ID for every clip; unknown clip_ids: "
            + ", ".join(sorted(unknown)),
        }

    clusters: dict[str, list[tuple[dict[str, Any], dict[str, Any]]]] = {}
    for pair in pairs:
        clusters.setdefault(pair[0]["reference"]["speaker"], []).append(pair)
    speakers = sorted(clusters)
    if len(speakers) < 2:
        return {
            "available": False,
            "reason": f"requires at least 2 known speaker IDs; found {len(speakers)}",
        }
    if any(
        not sum(candidate["word"]["reference_units"] for candidate, _ in cluster)
        for cluster in clusters.values()
    ):
        return {
            "available": False,
            "reason": "requires lexical reference words in every speaker cluster",
        }

    differences = {"word": [], "char": []}
    generator = random.Random(BOOTSTRAP_SEED)
    for _ in range(BOOTSTRAP_REPLICATES):
        sample = [
            pair
            for _ in speakers
            for pair in clusters[generator.choice(speakers)]
        ]
        for metric in differences:
            difference = _paired_rate_difference(sample, metric)
            if difference is not None:
                differences[metric].append(difference)

    def result(metric: str) -> dict[str, Any]:
        values = differences[metric]
        percentiles = quantiles(values, n=40, method="inclusive")
        return {
            "estimate": _paired_rate_difference(pairs, metric),
            "ci_95": [percentiles[0], percentiles[-1]],
        }

    return {
        "available": True,
        "speakers": len(speakers),
        "cluster_sizes": {speaker: len(clusters[speaker]) for speaker in speakers},
        "candidate_minus_baseline": {"wer": result("word"), "cer": result("char")},
    }


def _baseline_comparison(
    candidate_scores: Sequence[dict[str, Any]], baseline_scores: Sequence[dict[str, Any]]
) -> dict[str, Any]:
    baseline_by_id = {
        score["reference"]["clip_id"]: score for score in baseline_scores
    }
    by_language: dict[str, list[tuple[dict[str, Any], dict[str, Any]]]] = {}
    for candidate in candidate_scores:
        clip_id = candidate["reference"]["clip_id"]
        by_language.setdefault(candidate["reference"]["language"], []).append(
            (candidate, baseline_by_id[clip_id])
        )
    return {
        "scope": "all_cases",
        "direction": "candidate_minus_baseline",
        "method": {
            "resampling_unit": "speaker",
            "replicates": BOOTSTRAP_REPLICATES,
            "seed": BOOTSTRAP_SEED,
            "interval": "95% percentile",
        },
        "by_language": {
            language: _bootstrap_language(by_language[language])
            for language in sorted(by_language)
        },
    }


def evaluate_records(
    references: Sequence[Any],
    hypotheses: Sequence[Any],
    baseline_hypotheses: Sequence[Any] | None = None,
) -> dict[str, Any]:
    refs, hyps = validate_records(references, hypotheses)
    hypothesis_by_id = {item["clip_id"]: item for item in hyps}
    scores = [
        _score(reference, hypothesis_by_id[reference["clip_id"]]) for reference in refs
    ]
    baseline_scores = None
    if baseline_hypotheses is not None:
        _, baseline_hyps = validate_records(references, baseline_hypotheses)
        baseline_by_id = {item["clip_id"]: item for item in baseline_hyps}
        baseline_scores = [
            _score(reference, baseline_by_id[reference["clip_id"]])
            for reference in refs
        ]
    valid = [score for score in scores if score["hypothesis"]["status"] in OK_STATUSES]
    failed_ids = [
        score["reference"]["clip_id"]
        for score in scores
        if score["hypothesis"]["status"] in FAILURE_STATUSES
    ]
    unknown_speaker_ids = [
        score["reference"]["clip_id"]
        for score in scores
        if score["reference"]["speaker"].casefold() in _UNKNOWN_SPEAKERS
    ]
    return {
        "normalization": "NFC, casefold, canonical apostrophes, and whitespace collapse; lexical metrics discard sentence punctuation but retain accents, within-word apostrophes, numeric signs, and decimal separators",
        "counts": {
            "references": len(refs),
            "hypotheses": len(hyps),
            "statuses": dict(sorted(Counter(item["status"] for item in hyps).items())),
        },
        "gaps": {
            "failed_jobs_excluded_from_valid_only": failed_ids,
            "unknown_speakers": unknown_speaker_ids,
            "speaker_bootstrap": "unavailable; provide baseline hypotheses"
            if baseline_scores is None
            else "reported per language under baseline_comparison",
        },
        "baseline_comparison": None
        if baseline_scores is None
        else _baseline_comparison(scores, baseline_scores),
        "all_cases": _view(scores, scores),
        "valid_only": _view(scores, valid),
        "clips": [
            {
                "clip_id": score["reference"]["clip_id"],
                "language": score["reference"]["language"],
                "stratum": score["reference"]["stratum"],
                "speaker": score["reference"]["speaker"],
                "split": score["reference"]["split"],
                "status": score["hypothesis"]["status"],
                "reference_is_empty": score["no_speech"] is not None,
                "no_speech_classification": score["no_speech"],
                "word": score["word"],
                "char": score["char"],
                "critical": score["critical"],
                "anchors": score["anchors"],
            }
            for score in scores
        ],
    }


def evaluate_files(
    reference_path: str | Path,
    hypothesis_path: str | Path,
    baseline_hypothesis_path: str | Path | None = None,
) -> dict[str, Any]:
    return evaluate_records(
        load_jsonl(reference_path),
        load_jsonl(hypothesis_path),
        load_jsonl(baseline_hypothesis_path) if baseline_hypothesis_path else None,
    )


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Score offline ASR hypotheses from strict JSONL records"
    )
    parser.add_argument(
        "--references", required=True, type=Path, help="JSONL reference records"
    )
    parser.add_argument(
        "--hypotheses", required=True, type=Path, help="JSONL hypothesis records"
    )
    parser.add_argument(
        "--baseline-hypotheses",
        type=Path,
        help="optional JSONL baseline hypotheses for paired comparison",
    )
    parser.add_argument(
        "-o", "--output", type=Path, help="write the JSON report to this path"
    )
    args = parser.parse_args(argv)
    try:
        encoded = (
            json.dumps(
                evaluate_files(
                    args.references, args.hypotheses, args.baseline_hypotheses
                ),
                ensure_ascii=False,
                indent=2,
                sort_keys=True,
            )
            + "\n"
        )
        if args.output:
            args.output.write_text(encoded, encoding="utf-8")
        else:
            sys.stdout.write(encoded)
    except (OSError, SchemaError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
