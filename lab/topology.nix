# Lab topology: 4 routers in a ring, one eBGP session per link.
#
#   r1 ── r2
#   │      │
#   r4 ── r3        r4 also hosts the lab DNS resolver (unbound).
#
# Routers run as local QEMU VMs (no root, no host config changes):
#   - management: QEMU user networking, SSH forwarded to 127.0.0.1:<2220 + id>
#   - each link: a dedicated virtio NIC, wired point-to-point over UDP on 127.0.0.1
#     link id = 10*low + high, subnet 172.16.<link id>.0/30, .1 = lower id, .2 = higher id
# Each router owns loopback 10.0.255.<id>/32 and a "customer" prefix 10.100.<id>.0/24.
{
  routers = {
    r1 = { id = 1; asn = 65001; };
    r2 = { id = 2; asn = 65002; };
    r3 = { id = 3; asn = 65003; };
    r4 = { id = 4; asn = 65004; dns = true; };
  };

  links = [
    [ "r1" "r2" ]
    [ "r2" "r3" ]
    [ "r3" "r4" ]
    [ "r1" "r4" ]
  ];
}
