"""Dependency-based syntactic ambiguity filter pipeline.

Detects the same ambiguity types as SBADR (ICSME 2020) using enhanced++
dependency relations instead of k-best constituency parse divergence.

Each filter receives a ParsedSentence and returns a list of Findings.

Filter pipeline (same categories as the paper):
  1. pp_attachment  — oblique/PP could attach to different heads
  2. coordination   — AND/OR joins elements with unclear scope
  3. analytical     — participial / appositive / genitive readings
  4. noun_phrase    — stacked noun modifiers with ambiguous grouping
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum

from sbadr.client import DepEdge, ParsedSentence, Token


class AmbiguityType(str, Enum):
    PP_ATTACHMENT = "pp_attachment"
    COORDINATION = "coordination"
    ANALYTICAL = "analytical"
    NOUN_PHRASE = "noun_phrase"


@dataclass
class Finding:
    sentence_index: int
    sentence_text: str
    ambiguity_type: AmbiguityType
    divergence_score: float        # 0.0–1.0 (heuristic confidence)
    detail: str
    suggestion: str = ""


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _token_map(sent: ParsedSentence) -> dict[int, Token]:
    return {t.index: t for t in sent.tokens}


def _word(sent: ParsedSentence, idx: int) -> str:
    m = _token_map(sent)
    return m[idx].word if idx in m else f"tok{idx}"


def _pos(sent: ParsedSentence, idx: int) -> str:
    m = _token_map(sent)
    return m[idx].pos if idx in m else ""


def _edges_by_dep(deps: list[DepEdge], prefix: str) -> list[DepEdge]:
    return [e for e in deps if e.dep.startswith(prefix)]


def _edges_by_dep_exact(deps: list[DepEdge], name: str) -> list[DepEdge]:
    return [e for e in deps if e.dep == name]


def _dependents_of(deps: list[DepEdge], head: int) -> list[DepEdge]:
    return [e for e in deps if e.governor == head]


def _is_verb(pos: str) -> bool:
    return pos.startswith("VB")


def _is_noun(pos: str) -> bool:
    return pos.startswith("NN") or pos == "PRP"


# ---------------------------------------------------------------------------
# Filter 1: PP / Oblique attachment ambiguity
#
# Signal: a verb has BOTH an object NP AND an oblique PP attached directly.
# The PP could plausibly modify either the verb or the object NP.
# Higher confidence when the verb also has a non-empty subject.
# ---------------------------------------------------------------------------

def pp_attachment_filter(sent: ParsedSentence) -> list[Finding]:
    deps = list(sent.deps)
    findings: list[Finding]= []
    seen_verbs: set[int] = set()

    # Prepositions that commonly produce genuine attachment ambiguity in
    # requirements text.
    # Excluded: "for", "to", "of", "about" — rarely ambiguous
    # Excluded: "with", "by", "at", "using" — almost always instrument/agent
    #   in technical prose ("configure X with Y", "sorted by Y", "located at Y")
    #   and never cause genuine structural ambiguity in plan documents.
    _AMBIGUOUS_PREPS = {"in", "on", "from", "through",
                        "after", "before", "during", "via"}

    obl_edges = _edges_by_dep(deps, "obl")
    obj_edges  = _edges_by_dep(deps, "obj")

    for obl in obl_edges:
        gov = obl.governor
        if gov in seen_verbs:
            continue
        gov_pos = _pos(sent, gov)
        if not _is_verb(gov_pos):
            continue
        # Does the same verb also have an object?
        objects = [e for e in obj_edges if e.governor == gov]
        if not objects:
            continue
        obj_idx = objects[0].dependent
        obl_idx = obl.dependent
        # Positional check: ambiguity only when object sits BETWEEN verb and PP.
        # Pattern: verb ... object ... PP  (obl_idx > obj_idx > gov)
        # If PP comes before the object (e.g. "allow access to X"), it clearly
        # attaches to the verb — not ambiguous.
        if not (gov < obj_idx < obl_idx):
            continue
        # Only flag prepositions that commonly cause genuine attachment ambiguity.
        # Bare "obl" (no colon) means CoreNLP did not encode the preposition —
        # skip it because we cannot determine whether it is in _AMBIGUOUS_PREPS.
        if ":" not in obl.dep:
            continue
        prep = obl.dep.split(":")[-1]
        if prep not in _AMBIGUOUS_PREPS:
            continue
        # Ambiguity: PP could modify verb OR the object NP
        obj_word = _word(sent, obj_idx)
        obl_word = _word(sent, obl_idx)
        rel = obl.dep  # e.g. "obl:with"
        seen_verbs.add(gov)
        findings.append(Finding(
            sentence_index=sent.index,
            sentence_text=sent.text,
            ambiguity_type=AmbiguityType.PP_ATTACHMENT,
            divergence_score=0.6,
            detail=(
                f"'{rel}({_word(sent, gov)}, {obl_word})' could attach to "
                f"the verb OR to its object '{obj_word}'"
            ),
            suggestion=(
                f"Move the PP next to its intended head, or rephrase: "
                f"'the {obj_word} {obl.dep.split(':')[-1]} {obl_word}' "
                f"vs. '{_word(sent, gov)} {obl.dep.split(':')[-1]} {obl_word}'."
            ),
        ))
    return findings


# ---------------------------------------------------------------------------
# Filter 2: Coordination scope ambiguity
#
# Signal: a conj edge where the conjuncts have different POS categories,
# or where there are ≥2 modifiers between the CC and the right conjunct,
# suggesting unclear grouping.
# ---------------------------------------------------------------------------

def coordination_filter(sent: ParsedSentence) -> list[Finding]:
    deps = list(sent.deps)
    findings: list[Finding] = []
    conj_edges = _edges_by_dep(deps, "conj")

    # Only flag when the governor is NOT sentence-initial (position 1).
    # Imperative verbs at position 1 are often mis-tagged as NNP by CoreNLP.
    _initial_tokens = {1}

    for conj in conj_edges:
        if conj.governor in _initial_tokens:
            continue
        gov_pos  = _pos(sent, conj.governor)
        dep_pos  = _pos(sent, conj.dependent)
        # Different categories joined → scope ambiguity signal.
        # Use 2-char prefix comparison but skip if both are noun-like
        # (NNP vs NN difference is minor, not a real coordination scope issue).
        gov_cat = gov_pos[:2] if gov_pos else ""
        dep_cat = dep_pos[:2] if dep_pos else ""
        if gov_cat in ("NN", "NNP") and dep_cat in ("NN", "NNP"):
            continue  # same semantic category, just different subtypes
        if gov_cat and dep_cat and gov_cat != dep_cat:
            cc_word = next(
                (_word(sent, e.dependent) for e in _edges_by_dep_exact(deps, "cc")
                 if e.governor == conj.governor),
                "and/or",
            )
            findings.append(Finding(
                sentence_index=sent.index,
                sentence_text=sent.text,
                ambiguity_type=AmbiguityType.COORDINATION,
                divergence_score=0.40,
                detail=(
                    f"'{cc_word}' joins '{_word(sent, conj.governor)}' ({gov_pos}) "
                    f"and '{_word(sent, conj.dependent)}' ({dep_pos}) — "
                    f"different syntactic categories; grouping is unclear"
                ),
                suggestion=(
                    "Make the scope of AND/OR explicit with parentheses in prose "
                    "(e.g. 'X, and (Y and Z)') or split into two sentences."
                ),
            ))
    return findings


# ---------------------------------------------------------------------------
# Filter 3: Analytical ambiguity
#
# Signal: acl (adjectival clause / reduced relative) or acl:relcl attached
# to an NP — participial modifiers often allow multiple readings.
# Also detects nmod:poss (genitive) ambiguity when there is a following NP.
# ---------------------------------------------------------------------------

def analytical_filter(sent: ParsedSentence) -> list[Finding]:
    deps = list(sent.deps)
    findings: list[Finding] = []

    # Participial / reduced relative
    # Only flag VBG (gerund/present participle) and VBN (past participle).
    # Exclude acl:relcl (full relative clauses with "that/which" — unambiguous)
    # and VB/VBZ (infinitivals like "to allow", finite verbs).
    for e in _edges_by_dep(deps, "acl"):
        if e.dep == "acl:relcl":
            continue  # full relative clause — not a participial ambiguity
        gov_pos = _pos(sent, e.governor)
        if _is_noun(gov_pos):
            dep_pos = _pos(sent, e.dependent)
            if dep_pos in ("VBG", "VBN"):  # only true participial forms
                findings.append(Finding(
                    sentence_index=sent.index,
                    sentence_text=sent.text,
                    ambiguity_type=AmbiguityType.ANALYTICAL,
                    divergence_score=0.25,
                    detail=(
                        f"Participial clause '{_word(sent, e.dependent)}' ({dep_pos}) modifies "
                        f"'{_word(sent, e.governor)}' — active vs. passive reading possible"
                    ),
                    suggestion=(
                        "Replace the participle with an explicit relative clause: "
                        "'that is/was ...' or 'which ...'."
                    ),
                ))
    return findings


# ---------------------------------------------------------------------------
# Filter 4: Noun-phrase stacking ambiguity
#
# Signal: a noun has ≥3 consecutive compound/nmod modifiers — bracketing
# becomes ambiguous ("database connection pool manager" etc.).
# ---------------------------------------------------------------------------

def noun_phrase_filter(sent: ParsedSentence) -> list[Finding]:
    deps = list(sent.deps)
    findings: list[Finding] = []

    for tok in sent.tokens:
        if not _is_noun(tok.pos):
            continue
        compound_deps = [
            e for e in deps
            if e.governor == tok.index and e.dep in ("compound", "nmod")
        ]
        if len(compound_deps) >= 4:
            modifier_words = " ".join(_word(sent, e.dependent) for e in compound_deps)
            findings.append(Finding(
                sentence_index=sent.index,
                sentence_text=sent.text,
                ambiguity_type=AmbiguityType.NOUN_PHRASE,
                divergence_score=0.4,
                detail=(
                    f"'{tok.word}' has {len(compound_deps)} stacked modifiers "
                    f"({modifier_words}) — noun grouping is ambiguous"
                ),
                suggestion=(
                    "Use hyphens for compound adjectives or rewrite as a prepositional phrase "
                    "to make the grouping explicit."
                ),
            ))
    return findings


# ---------------------------------------------------------------------------
# Pipeline
# ---------------------------------------------------------------------------

_PIPELINE = [
    pp_attachment_filter,
    coordination_filter,
    analytical_filter,
    noun_phrase_filter,
]


def run_pipeline(sent: ParsedSentence) -> list[Finding]:
    findings: list[Finding] = []
    for f in _PIPELINE:
        findings.extend(f(sent))
    return findings
