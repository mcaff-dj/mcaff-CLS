"""Environment/config loader. Env vars first, then CRM-PEP/.env.local fallback -
never a hardcoded secret. Mirrors scripts/mysql_lib.py's loading convention.
"""
import os
from pathlib import Path

CRM_PEP_DIR = Path(__file__).resolve().parent
_env_local_loaded = False


def _load_env_local():
    global _env_local_loaded
    if _env_local_loaded:
        return
    _env_local_loaded = True
    env_file = CRM_PEP_DIR / ".env.local"
    if not env_file.exists():
        return
    for line in env_file.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        k = k.strip()
        if k not in os.environ:
            os.environ[k] = v.strip()


def get(key, default=None, required=False):
    _load_env_local()
    value = os.environ.get(key, default)
    if required and not value:
        raise RuntimeError(
            f"Missing required config '{key}'. Set it as an environment variable "
            f"or in CRM-PEP/.env.local (see .env.example)."
        )
    return value
