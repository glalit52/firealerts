import os
import sys
import tempfile

_tmp = tempfile.mkdtemp(prefix="firealerts-test-")
os.environ.setdefault("DATABASE_URL", f"sqlite:///{_tmp}/test.db")
os.environ["DATA_MODE"] = "demo"
os.environ["SCHEDULER_ENABLED"] = "0"
os.environ["GOES_ENABLED"] = "0"
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
