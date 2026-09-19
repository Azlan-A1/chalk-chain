import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from chalkvision import words  # noqa: E402


def test_transcript_tokens_splits_and_normalises():
    toks = words.transcript_tokens(["Conversation Lesson", "Subject - The Chair", "Monday, March 25, 1901"])
    assert {"conversation", "lesson", "subject", "the", "chair", "monday", "march"} <= toks


def test_two_letter_words_can_still_match():
    # 'ua' (flower) is in the Swahili list; a 3-character minimum made it unmatchable.
    assert words.find_words(["ua"], words.transcript_tokens(["ua", "jua"])) == {"ua"}


def test_decoys_are_never_confusable_with_the_real_words():
    for lang, expected in (("en", ["apple", "chain", "horse"]), ("sw", ["askari", "daftari", "amani"])):
        for seed in range(12):
            _, decoys = words.build_candidates(expected, [], bytes([seed]) * 32, lang)
            for d in decoys:
                assert not any(words.confusable(d, e) for e in expected), (lang, d, expected)


def test_find_words_tolerates_a_misread_letter_in_longer_words():
    toks = words.transcript_tokens(["lion", "chalr", "kitabu"])  # "chalr" is a misread "chair"
    assert words.find_words(["lion", "chair", "kitabu", "rain"], toks) == {"lion", "chair", "kitabu"}


def test_find_words_requires_short_words_to_match_exactly():
    toks = words.transcript_tokens(["boat", "cot"])
    assert words.find_words(["bat", "cat", "boat"], toks) == {"boat"}


def test_find_words_does_not_match_unrelated_words():
    toks = words.transcript_tokens(["keep on saving", "siberia"])
    assert words.find_words(["gate", "rain", "lion", "cup"], toks) == set()
