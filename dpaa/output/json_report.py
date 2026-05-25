from dpaa.models import Report
import json


def to_json(report: Report, indent: int = 2) -> str:
    return json.dumps(report.model_dump(), indent=indent, ensure_ascii=False)
