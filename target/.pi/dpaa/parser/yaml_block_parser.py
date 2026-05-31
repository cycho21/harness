from __future__ import annotations
import re
import yaml

YAML_BLOCK_RE = re.compile(r"```yaml\r?\n(.*?)```", re.DOTALL)


class YamlBlockParser:
    def extract_steps(self, content: str) -> list[dict]:
        match = YAML_BLOCK_RE.search(content)
        if not match:
            return []
        data = yaml.safe_load(match.group(1))
        if not isinstance(data, dict):
            return []
        return data.get("steps", [])
