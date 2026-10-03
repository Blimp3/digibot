"""Runnable regression check for the offline JSONL ASR evaluator."""

from __future__ import annotations

import copy
import io
import json
import tempfile
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path

from asr_eval import (
    SchemaError,
    evaluate_records,
    load_jsonl,
    main,
    normalize_lexical_text,
    normalize_text,
)


def _provenance() -> dict[str, object]:
    return {
        "sha256": "a" * 64,
        "license": "CC BY 4.0",
        "source": "fixture://offline-test",
        "revision": "fixture-r1",
        "crop": {"start_s": 0, "end_s": 10},
    }


def _reference(
    clip_id: str,
    language: str,
    speaker: str,
    text: str,
    *,
    stratum: str = "clear_read",
    split: str = "heldout",
    critical: list[dict[str, object]] | None = None,
    anchors: list[dict[str, object]] | None = None,
) -> dict[str, object]:
    return {
        "clip_id": clip_id,
        "language": language,
        "stratum": stratum,
        "speaker": speaker,
        "split": split,
        "text": text,
        "provenance": _provenance(),
        "critical": critical or [],
        "anchors": anchors or [],
    }


def _hypothesis(
    clip_id: str,
    text: str,
    *,
    status: str = "ok",
    segments: list[dict[str, object]] | None = None,
) -> dict[str, object]:
    if segments is None:
        segments = (
            [{"start_s": 0, "end_s": 1, "text": text}]
            if status == "ok" and text
            else []
        )
    return {
        "clip_id": clip_id,
        "status": status,
        "text": text,
        "segments": segments,
    }


def _records() -> tuple[list[dict[str, object]], list[dict[str, object]]]:
    references = [
        _reference(
            "en-edit",
            "en",
            "en-1",
            "alpha bravo green",
            stratum="parliamentary",
            critical=[
                {"id": "opening", "accepted_forms": ["alpha delta", "alpha bravo"]}
            ],
            anchors=[
                {
                    "id": "tail",
                    "start_s": 2,
                    "end_s": 4,
                    "accepted_forms": ["green lantern"],
                }
            ],
        ),
        _reference(
            "it-meaning",
            "it",
            "it-1",
            "L’accento è importante: 12, non -3.",
            stratum="source_accented_parliamentary",
            critical=[{"id": "negation", "accepted_forms": ["non", "non è"]}],
            anchors=[
                {"id": "number", "start_s": 1, "end_s": 3, "accepted_forms": ["no -3"]}
            ],
        ),
        _reference(
            "failed",
            "en",
            "en-2",
            "one two",
            critical=[{"id": "failed-critical", "accepted_forms": ["ignored output"]}],
            anchors=[
                {
                    "id": "failed-anchor",
                    "start_s": 0,
                    "end_s": 1,
                    "accepted_forms": ["partial diagnostic"],
                }
            ],
        ),
        _reference(
            "empty", "en", "en-3", "", stratum="quiet_noise", split="non_speech"
        ),
        _reference(
            "punctuation", "en", "en-4", "", stratum="quiet_noise", split="non_speech"
        ),
        _reference(
            "annotation", "en", "en-5", "", stratum="quiet_noise", split="non_speech"
        ),
        _reference(
            "lexical", "it", "unknown", "", stratum="quiet_noise", split="non_speech"
        ),
        _reference(
            "failed-empty", "it", "it-3", "", stratum="quiet_noise", split="non_speech"
        ),
    ]
    hypotheses = [
        _hypothesis(
            "en-edit",
            "alpha delta green lantern",
            segments=[
                {"start_s": 0, "end_s": 1, "text": "alpha delta"},
                {"start_s": 2.1, "end_s": 3, "text": "green lantern"},
            ],
        ),
        _hypothesis(
            "it-meaning",
            "l’accento è importante: 12, no -3.",
            segments=[
                {"start_s": 0, "end_s": 1, "text": "l’accento è importante: 12,"},
                {"start_s": 1.1, "end_s": 2, "text": "no -3."},
            ],
        ),
        _hypothesis(
            "failed",
            "ignored output",
            status="processing_failure",
            segments=[{"start_s": 0, "end_s": 1, "text": "partial diagnostic"}],
        ),
        _hypothesis("empty", "", status="no_speech"),
        _hypothesis("punctuation", "… —"),
        _hypothesis("annotation", "[music]"),
        _hypothesis("lexical", "parola"),
        _hypothesis("failed-empty", "", status="processing_failure"),
    ]
    return references, hypotheses


def _expect_schema_error(operation: object) -> None:
    try:
        operation()  # type: ignore[operator]
    except SchemaError:
        return
    raise AssertionError("invalid input was accepted")


def _critical_match(accepted_form: str, output: str) -> bool:
    reference = _reference(
        "numeric",
        "en",
        "numeric-1",
        "reference",
        critical=[{"id": "numeric", "accepted_forms": [accepted_form]}],
    )
    hypothesis = _hypothesis("numeric", output)
    return evaluate_records([reference], [hypothesis])["clips"][0]["critical"][0][
        "matched"
    ]


def run() -> None:
    references, hypotheses = _records()
    report = evaluate_records(references, hypotheses)
    clips = {clip["clip_id"]: clip for clip in report["clips"]}

    assert clips["en-edit"]["word"] == {
        "reference_units": 3,
        "substitutions": 1,
        "deletions": 0,
        "insertions": 1,
        "errors": 2,
        "wer": 2 / 3,
    }
    assert normalize_text("L’ÀCQUA +12  non -3") == "l'àcqua +12 non -3"
    assert (
        normalize_lexical_text("L’accento, eh, eh: è +12,50; non -3.")
        == "l'accento eh eh è +12,50 non -3"
    )
    assert clips["it-meaning"]["word"]["substitutions"] == 1
    assert clips["it-meaning"]["word"]["wer"] == 1 / 6
    assert clips["it-meaning"]["critical"][0]["matched"] is False
    assert clips["it-meaning"]["anchors"][0]["matched"] is True
    assert clips["en-edit"]["critical"][0]["matched_form"] == "alpha delta"
    assert clips["en-edit"]["anchors"][0]["matched_form"] == "green lantern"
    assert [
        _critical_match("12", output) for output in ("12", "-12", "12.50", "120")
    ] == [True, False, False, False]
    assert _critical_match("12.50", "-12.50") is False

    all_cases = report["all_cases"]
    valid_only = report["valid_only"]
    assert all_cases["by_clip"]["failed"]["metrics"]["word"]["deletions"] == 2
    assert clips["failed"]["critical"][0]["matched"] is False
    assert clips["failed"]["anchors"][0]["segments_considered"] == 0
    assert clips["failed"]["anchors"][0]["matched"] is False
    assert valid_only["by_clip"]["failed"]["included"] is False
    assert valid_only["by_clip"]["failed"]["metrics"] is None
    assert all_cases["by_clip"]["empty"]["metrics"]["word"]["wer"] is None
    assert all_cases["no_speech"] == {
        "empty": 1,
        "punctuation_or_symbol_only": 1,
        "non_speech_annotation": 1,
        "lexical_output": 1,
        "processing_failure": 1,
    }
    assert valid_only["no_speech"]["processing_failure"] == 0
    assert clips["empty"]["no_speech_classification"] == "empty"
    assert (
        clips["punctuation"]["no_speech_classification"] == "punctuation_or_symbol_only"
    )
    assert clips["annotation"]["no_speech_classification"] == "non_speech_annotation"
    assert clips["lexical"]["no_speech_classification"] == "lexical_output"
    assert clips["failed-empty"]["no_speech_classification"] == "processing_failure"
    assert valid_only["by_clip"]["empty"]["included"] is True
    assert report["gaps"]["unknown_speakers"] == ["lexical"]
    assert report["gaps"]["speaker_bootstrap"].startswith("unavailable;")
    assert report == evaluate_records(references, hypotheses)

    consistent_join = _hypothesis(
        "joined",
        "L’ACQUA\n  è fredda",
        segments=[
            {"start_s": 0, "end_s": 1, "text": "l'acqua"},
            {"start_s": 1, "end_s": 2, "text": "è fredda"},
        ],
    )
    assert evaluate_records(
        [_reference("joined", "it", "speaker-1", "L'acqua è fredda")],
        [consistent_join],
    )["clips"][0]["word"]["wer"] == 0

    boundary_reference = [_reference("contradiction", "en", "speaker-1", "word")]
    _expect_schema_error(
        lambda: evaluate_records(
            boundary_reference,
            [_hypothesis("contradiction", "word", status="no_speech")],
        )
    )
    _expect_schema_error(
        lambda: evaluate_records(
            boundary_reference,
            [
                _hypothesis(
                    "contradiction",
                    "",
                    status="no_speech",
                    segments=[{"start_s": 0, "end_s": 1, "text": "word"}],
                )
            ],
        )
    )
    _expect_schema_error(
        lambda: evaluate_records(
            boundary_reference,
            [
                _hypothesis(
                    "contradiction",
                    "",
                    segments=[{"start_s": 0, "end_s": 1, "text": "word"}],
                )
            ],
        )
    )

    punctuation_report = evaluate_records(
        [_reference("punctuation-metric", "en", "speaker-1", "Hello, world.")],
        [_hypothesis("punctuation-metric", "hello world")],
    )
    assert punctuation_report["clips"][0]["word"]["wer"] == 0
    assert punctuation_report["clips"][0]["char"]["cer"] == 0

    meaning_reference = _reference(
        "lexical-meaning",
        "it",
        "speaker-1",
        "L’accento, eh, eh: è +12,50; non -3.",
    )
    equivalent = evaluate_records(
        [meaning_reference],
        [_hypothesis("lexical-meaning", "l'accento eh eh è +12,50 non -3")],
    )
    changed = evaluate_records(
        [meaning_reference],
        [_hypothesis("lexical-meaning", "l'accento eh eh e 12,50 non 3")],
    )
    assert equivalent["clips"][0]["word"]["wer"] == 0
    assert changed["clips"][0]["word"]["substitutions"] == 3

    bootstrap_references = [
        _reference("speaker-a-1", "en", "speaker-a", "one two"),
        _reference("speaker-a-2", "en", "speaker-a", "three four"),
        _reference("speaker-b-1", "en", "speaker-b", "five six"),
    ]
    bootstrap_candidate = [
        _hypothesis("speaker-a-1", "", status="processing_failure"),
        _hypothesis("speaker-a-2", ""),
        _hypothesis("speaker-b-1", "five six"),
    ]
    bootstrap_baseline = [
        _hypothesis("speaker-a-1", "one two"),
        _hypothesis("speaker-a-2", "three four"),
        _hypothesis("speaker-b-1", ""),
    ]
    bootstrap_report = evaluate_records(
        bootstrap_references, bootstrap_candidate, bootstrap_baseline
    )
    bootstrap = bootstrap_report["baseline_comparison"]["by_language"]["en"]
    assert bootstrap_report["baseline_comparison"]["scope"] == "all_cases"
    assert bootstrap["available"] is True
    assert bootstrap["cluster_sizes"] == {"speaker-a": 2, "speaker-b": 1}
    assert bootstrap["candidate_minus_baseline"]["wer"] == {
        "estimate": 1 / 3,
        "ci_95": [-1.0, 1.0],
    }
    assert bootstrap_report == evaluate_records(
        bootstrap_references, bootstrap_candidate, bootstrap_baseline
    )

    unknown_speaker_references = copy.deepcopy(bootstrap_references)
    unknown_speaker_references[0]["speaker"] = "unknown"
    unavailable = evaluate_records(
        unknown_speaker_references, bootstrap_candidate, bootstrap_baseline
    )["baseline_comparison"]["by_language"]["en"]
    assert unavailable["available"] is False
    assert "unknown clip_ids: speaker-a-1" in unavailable["reason"]
    one_speaker = evaluate_records(
        bootstrap_references[:2], bootstrap_candidate[:2], bootstrap_baseline[:2]
    )["baseline_comparison"]["by_language"]["en"]
    assert one_speaker["available"] is False
    assert one_speaker["reason"] == "requires at least 2 known speaker IDs; found 1"

    ambiguous_annotation = copy.deepcopy(hypotheses)
    ambiguous_annotation[5]["text"] = "[music do not pay]"
    ambiguous_annotation[5]["segments"][0]["text"] = "[music do not pay]"
    ambiguous_report = evaluate_records(references, ambiguous_annotation)
    assert ambiguous_report["clips"][5]["no_speech_classification"] == "lexical_output"

    duplicate = copy.deepcopy(references)
    duplicate.append(copy.deepcopy(duplicate[0]))
    _expect_schema_error(lambda: evaluate_records(duplicate, hypotheses))
    unmatched = copy.deepcopy(hypotheses)
    unmatched[0]["clip_id"] = "missing-reference"
    _expect_schema_error(lambda: evaluate_records(references, unmatched))
    invalid_field = copy.deepcopy(references)
    invalid_field[0]["oops"] = True
    _expect_schema_error(lambda: evaluate_records(invalid_field, hypotheses))
    invalid_stratum = copy.deepcopy(references)
    invalid_stratum[0]["stratum"] = "source accented parliamentary"
    _expect_schema_error(lambda: evaluate_records(invalid_stratum, hypotheses))

    with tempfile.TemporaryDirectory() as directory:
        directory_path = Path(directory)
        references_path = directory_path / "references.jsonl"
        hypotheses_path = directory_path / "hypotheses.jsonl"
        baseline_path = directory_path / "baseline.jsonl"
        references_path.write_text(
            "\n".join(json.dumps(item, ensure_ascii=False) for item in references)
            + "\n",
            encoding="utf-8",
        )
        hypotheses_path.write_text(
            "\n".join(json.dumps(item, ensure_ascii=False) for item in hypotheses)
            + "\n",
            encoding="utf-8",
        )
        baseline_path.write_text(
            "\n".join(json.dumps(item, ensure_ascii=False) for item in hypotheses)
            + "\n",
            encoding="utf-8",
        )
        assert load_jsonl(references_path)[0]["clip_id"] == "en-edit"
        output = io.StringIO()
        with redirect_stdout(output):
            assert (
                main(
                    [
                        "--references",
                        str(references_path),
                        "--hypotheses",
                        str(hypotheses_path),
                        "--baseline-hypotheses",
                        str(baseline_path),
                    ]
                )
                == 0
            )
        cli_report = json.loads(output.getvalue())
        assert cli_report["counts"]["references"] == 8
        assert cli_report["counts"]["statuses"]["no_speech"] == 1
        assert cli_report["baseline_comparison"]["method"]["replicates"] == 1000

        duplicate_keys_path = directory_path / "duplicate-keys.jsonl"
        duplicate_keys_path.write_text(
            '{"clip_id":"a","clip_id":"b"}\n', encoding="utf-8"
        )
        _expect_schema_error(lambda: load_jsonl(duplicate_keys_path))

        huge_number_path = directory_path / "huge-number.jsonl"
        huge_number_references = copy.deepcopy(references)
        huge_number_references[0]["provenance"]["crop"]["end_s"] = 10**400
        huge_number_path.write_text(
            "\n".join(
                json.dumps(item, ensure_ascii=False) for item in huge_number_references
            )
            + "\n",
            encoding="utf-8",
        )
        error = io.StringIO()
        with redirect_stderr(error):
            assert (
                main(
                    [
                        "--references",
                        str(huge_number_path),
                        "--hypotheses",
                        str(hypotheses_path),
                    ]
                )
                == 2
            )
        assert "expected a finite number" in error.getvalue()

    print("PASS test_asr_eval")


if __name__ == "__main__":
    run()
