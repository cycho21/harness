from pathlib import Path
import sys


ROOT = Path(__file__).resolve().parents[1]
PI_ROOT = ROOT / "target" / ".pi"

if str(PI_ROOT) not in sys.path:
    sys.path.insert(0, str(PI_ROOT))
