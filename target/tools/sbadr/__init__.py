"""SBADR — Score-Based Ambiguity Detector and Resolver.

Implements syntactic ambiguity detection for plan documents using
Stanford CoreNLP k-best constituency parsing, as described in:
  "Score-Based Automatic Detection and Resolution of Syntactic Ambiguity
  in Natural Language Requirements" (ICSME 2020).

Usage:
    from sbadr import analyze_file
    result = analyze_file("plan.en.md")
"""

__version__ = "0.1.0"

from sbadr.analyzer import analyze_file, AnalysisResult  # noqa: F401
