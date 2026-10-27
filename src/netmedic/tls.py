"""Local certificate authority so an iPhone on the LAN can open netmedic over HTTPS.

Safari only grants camera access in a secure context. netmedic creates its own CA once; the CA
certificate is installed and trusted on the phone, then every server certificate it signs (for the
machine's LAN addresses) is accepted.
"""

from __future__ import annotations

import datetime as dt
import ipaddress
import socket
from pathlib import Path

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID

CERT_DIR = Path("certs")


def lan_addresses() -> list[str]:
    """Best-effort list of this machine's IPv4 addresses reachable from the LAN."""
    addrs = set()
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("192.0.2.1", 9))  # no packet is sent: only picks the outgoing interface
            addrs.add(s.getsockname()[0])
    except OSError:
        pass
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            addrs.add(info[4][0])
    except OSError:
        pass
    return sorted(a for a in addrs if not a.startswith("127."))


def _write_key(key: ec.EllipticCurvePrivateKey, path: Path) -> None:
    path.write_bytes(key.private_bytes(
        serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
    path.chmod(0o600)


def _name(cn: str) -> x509.Name:
    return x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, cn),
                      x509.NameAttribute(NameOID.ORGANIZATION_NAME, "netmedic local")])


def ensure_ca(directory: Path = CERT_DIR) -> tuple[Path, Path]:
    directory.mkdir(exist_ok=True)
    cert_path, key_path = directory / "netmedic-ca.crt", directory / "netmedic-ca.key"
    if cert_path.exists() and key_path.exists():
        return cert_path, key_path
    key = ec.generate_private_key(ec.SECP256R1())
    now = dt.datetime.now(dt.timezone.utc)
    cert = (
        x509.CertificateBuilder()
        .subject_name(_name("netmedic local CA")).issuer_name(_name("netmedic local CA"))
        .public_key(key.public_key()).serial_number(x509.random_serial_number())
        .not_valid_before(now - dt.timedelta(days=1)).not_valid_after(now + dt.timedelta(days=3650))
        .add_extension(x509.BasicConstraints(ca=True, path_length=0), critical=True)
        .add_extension(x509.KeyUsage(digital_signature=True, key_cert_sign=True, crl_sign=True,
                                     content_commitment=False, key_encipherment=False,
                                     data_encipherment=False, key_agreement=False,
                                     encipher_only=False, decipher_only=False), critical=True)
        .add_extension(x509.SubjectKeyIdentifier.from_public_key(key.public_key()), critical=False)
        .sign(key, hashes.SHA256())
    )
    _write_key(key, key_path)
    cert_path.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    return cert_path, key_path


def server_cert(hosts: list[str], directory: Path = CERT_DIR) -> tuple[Path, Path]:
    """(Re)issue the server certificate for the given hosts/IPs, signed by the local CA."""
    ca_cert_path, ca_key_path = ensure_ca(directory)
    ca_cert = x509.load_pem_x509_certificate(ca_cert_path.read_bytes())
    ca_key = serialization.load_pem_private_key(ca_key_path.read_bytes(), password=None)
    key = ec.generate_private_key(ec.SECP256R1())
    now = dt.datetime.now(dt.timezone.utc)
    sans: list[x509.GeneralName] = []
    for h in dict.fromkeys(["localhost", "127.0.0.1", *hosts]):
        try:
            sans.append(x509.IPAddress(ipaddress.ip_address(h)))
        except ValueError:
            sans.append(x509.DNSName(h))
    cert = (
        x509.CertificateBuilder()
        .subject_name(_name("netmedic")).issuer_name(ca_cert.subject)
        .public_key(key.public_key()).serial_number(x509.random_serial_number())
        # iOS rejects server certificates valid for more than 825 days.
        .not_valid_before(now - dt.timedelta(days=1)).not_valid_after(now + dt.timedelta(days=397))
        .add_extension(x509.SubjectAlternativeName(sans), critical=False)
        .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
        .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]), critical=False)
        .add_extension(x509.AuthorityKeyIdentifier.from_issuer_public_key(ca_key.public_key()), critical=False)
        .sign(ca_key, hashes.SHA256())
    )
    cert_path, key_path = directory / "server.crt", directory / "server.key"
    _write_key(key, key_path)
    # Full chain so clients that only trust the CA can build the path.
    cert_path.write_bytes(cert.public_bytes(serialization.Encoding.PEM) + ca_cert_path.read_bytes())
    return cert_path, key_path
