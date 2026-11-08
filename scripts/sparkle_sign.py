#!/usr/bin/env python3
"""Sparkle EdDSA (Ed25519) signature of an update archive — what Sparkle's sign_update prints.

The private key is the base64 32-byte seed (Sparkle's `generate_keys -x` format), taken from the
SPARKLE_PRIVATE_KEY environment variable so it never touches the disk.

  usage: SPARKLE_PRIVATE_KEY=… sparkle_sign.py <archive>          → base64 signature
         SPARKLE_PRIVATE_KEY=… sparkle_sign.py --public-key        → base64 public key (SUPublicEDKey)
"""
import base64, os, sys
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives import serialization

raw = os.environ.get("SPARKLE_PRIVATE_KEY", "").strip()
if not raw:
    sys.exit("SPARKLE_PRIVATE_KEY is not set")
seed = base64.b64decode(raw)
if len(seed) != 32:
    sys.exit(f"SPARKLE_PRIVATE_KEY must be a base64 32-byte Ed25519 seed (got {len(seed)} bytes)")
key = Ed25519PrivateKey.from_private_bytes(seed)

if sys.argv[1:] == ["--public-key"]:
    pub = key.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
    print(base64.b64encode(pub).decode())
elif len(sys.argv) == 2:
    with open(sys.argv[1], "rb") as f:
        print(base64.b64encode(key.sign(f.read())).decode())
else:
    sys.exit(__doc__)
