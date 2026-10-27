# One router of the "enterprise" lab, as a local QEMU VM.
# The base BIRD config (read-only, /nix/store) holds router id, device/direct/kernel protocols.
# Everything an operator would touch lives in /var/lib/netagent/{10-policy,20-ospf,30-bgp}.conf, seeded
# from /etc/netagent/baseline/: that is what netmedic (and the chaos script) may modify.
{ name, topology }:
{ config, lib, pkgs, modulesPath, ... }:
let
  t = topology;
  me = t.routers.${name};
  ids = n: toString t.routers.${n}.id;
  lo = n: "10.0.255.${ids n}";
  inAS = n: t.routers.${n}.asn == me.asn;
  dcName = lib.findFirst (n: lib.elem "dns" (t.routers.${n}.services or [ ])) null (lib.attrNames t.routers);
  rrs = lib.filter (n: (t.routers.${n}.rr or false) && inAS n && n != name) (lib.attrNames t.routers);
  ibgpPeers =
    if me.rr or false
    then lib.filter (n: n != name && inAS n && t.routers.${n}.role != "isp") (lib.attrNames t.routers)
    else rrs;
  isISP = me.role == "isp";
  ownNets = if me.asn == 65000 then "10.100.0.0/16" else "10.110.0.0/16";

  myLinks = lib.concatLists (lib.imap0
    (i: pair:
      let
        a = lib.elemAt pair 0; b = lib.elemAt pair 1;
        peer = if a == name then b else a;
        side = if a == name then 1 else 2;
      in
      lib.optional (lib.elem name pair) rec {
        inherit i peer;
        iface = "to-${peer}";
        internal = inAS peer;
        mac = "52:54:00:ac:${lib.fixedWidthString 2 "0" (toString i)}:0${toString side}";
        localPort = 41000 + i * 10 + side;
        remotePort = 41000 + i * 10 + (3 - side);
        local = "172.16.${toString i}.${toString side}";
        remote = "172.16.${toString i}.${toString (3 - side)}";
        peerAsn = t.routers.${peer}.asn;
        peerRole = t.routers.${peer}.role;
      })
    t.links);

  internalLinks = lib.filter (l: l.internal) myLinks;
  ebgpLinks = lib.filter (l: !l.internal) myLinks;

  timers = "  hold time 9;\n  keepalive time 3;\n  connect retry time 5;\n  error wait time 2, 10;\n";

  # ---------------- policy.conf ----------------
  policy = ''
    # Routing policy (agent-managed). Filters referenced by bgp.conf.
    define BOGONS = [ 0.0.0.0/8+, 10.0.0.0/8+, 100.64.0.0/10+, 127.0.0.0/8+, 169.254.0.0/16+,
                      172.16.0.0/12+, 192.168.0.0/16+, 224.0.0.0/3+ ];
    define LOOPBACKS = [ 10.0.255.0/24+ ];

  '' + lib.optionalString (me.asn == 65000) ''
    # iBGP: customer prefixes (+ the branch loopback learned over eBGP); our own loopbacks are
    # carried by OSPF, aggregates stay on the edges.
    filter ibgp_out {
      if net ~ LOOPBACKS && source != RTS_BGP then reject;
      if source = RTS_STATIC then reject;
      accept;
    }

  '' + lib.optionalString (me.role == "edge") ''
    define UPSTREAM_PREF = ${toString me.upstreamPref};

    filter from_upstream {
      if net = 0.0.0.0/0 then { bgp_local_pref = UPSTREAM_PREF; accept; }
      if net ~ BOGONS || net.len > 24 then reject;
      bgp_local_pref = UPSTREAM_PREF;
      accept;
    }

    # Announce only our aggregates to the internet.
    filter to_upstream {
      if net ~ [ 10.100.0.0/16, 10.110.0.0/16 ] then accept;
      reject;
    }

    protocol static aggregates {
      ipv4;
      route 10.100.0.0/16 blackhole;
      route 10.110.0.0/16 blackhole;
    }

  '' + lib.optionalString (me.role == "core") ''
    filter from_branch {
      if net ~ [ 10.110.0.0/16{16,24}, 10.0.255.0/24{32,32} ] then accept;
      reject;
    }

    filter to_branch {
      if net = 0.0.0.0/0 then accept;
      if net ~ LOOPBACKS then accept;
      if net ~ [ 10.100.0.0/16{16,32} ] then accept;
      reject;
    }

  '' + lib.optionalString (me.role == "branch") ''
    filter to_core {
      if net ~ [ 10.110.0.0/16{16,24} ] then accept;
      if net ~ LOOPBACKS && source = RTS_DEVICE then accept;  # our loopback, for monitoring
      reject;
    }

    filter from_core {
      accept;
    }

  '' + lib.optionalString isISP ''
    filter from_customer {
      if net ~ [ 10.100.0.0/16, 10.110.0.0/16 ] then accept;
      reject;
    }

    filter to_customer {
      if net ~ LOOPBACKS then reject;
      accept;
    }

    filter from_peer {
      if net = 0.0.0.0/0 || net ~ LOOPBACKS then reject;
      accept;
    }

    filter to_peer {
      if net = 0.0.0.0/0 || net ~ LOOPBACKS then reject;
      accept;
    }

    protocol static isp_default {
      ipv4;
      route 0.0.0.0/0 blackhole;
    }
  '';

  # ---------------- ospf.conf (AS65000 only) ----------------
  ospf = ''
    # IGP: infrastructure loopbacks only.
    protocol ospf v2 ospf1 {
      ipv4 { import all; export none; };
      area 0 {
        interface "lo-svc" { stub yes; };
        interface ${lib.concatMapStringsSep ", " (l: "\"${l.iface}\"") internalLinks} {
          type ptp;
          cost 10;
          hello 2;
          dead 8;
        };
      };
    }
  '';

  # ---------------- bgp.conf ----------------
  ibgpSession = peer: ''
    protocol bgp ibgp_${peer} {
      description "iBGP to ${peer}";
      local ${lo name} as ${toString me.asn};
      neighbor ${lo peer} as ${toString me.asn};
    ${lib.optionalString ((me.rr or false) && !(t.routers.${peer}.rr or false)) "  rr client;\n"}${timers}  ipv4 {
        import all;
        export filter ibgp_out;
    ${lib.optionalString (me.role == "edge" || me.role == "core") "    next hop self ebgp;\n"}  };
    }

  '';

  ebgpFilters = l:
    if me.role == "edge" then { imp = "from_upstream"; exp = "to_upstream"; extra = "    import limit 1000 action restart;\n"; }
    else if me.role == "core" then { imp = "from_branch"; exp = "to_branch"; extra = "    import limit 10 action disable;\n"; }
    else if me.role == "branch" then { imp = "from_core"; exp = "to_core"; extra = ""; }
    else if l.peerRole == "isp" then { imp = "from_peer"; exp = "to_peer"; extra = ""; }
    else { imp = "from_customer"; exp = "to_customer"; extra = ""; };

  ebgpSession = l: let f = ebgpFilters l; in ''
    protocol bgp ebgp_${l.peer} {
      description "eBGP to ${l.peer} (AS${toString l.peerAsn})";
      local ${l.local} as ${toString me.asn};
      neighbor ${l.remote} as ${toString l.peerAsn};
    ${timers}  ipv4 {
    ${f.extra}    import filter ${f.imp};
        export filter ${f.exp};
      };
    }

  '';

  bgp = "# BGP sessions (agent-managed).\n\n"
    + lib.optionalString (me.asn == 65000) (lib.concatMapStrings ibgpSession ibgpPeers)
    + lib.concatMapStrings ebgpSession ebgpLinks;

  lan = if isISP then me.internet else if me ? lan then me.lan else "10.100.${ids name}.1/24";
  extraLan = lib.optional (me.role == "branch") "10.110.19.1/24"
    ++ lib.optional (name == dcName) "10.100.${ids name}.10/32";

  # Numbered: BIRD includes the glob in order, filters must be defined before the sessions using them.
  baselineFiles = { "10-policy.conf" = policy; "30-bgp.conf" = bgp; } // lib.optionalAttrs (me.asn == 65000) { "20-ospf.conf" = ospf; };
in
{
  imports = [ "${modulesPath}/virtualisation/qemu-vm.nix" ];

  virtualisation = {
    memorySize = 448;
    cores = 1;
    graphics = false;
    diskImage = null;
    forwardPorts = [{ from = "host"; host.address = "127.0.0.1"; host.port = 2220 + me.id; guest.port = 22; }];
    sharedDirectories.lab = { source = "$LAB_STATE"; target = "/mnt/lab"; };
    qemu.options = lib.concatMap (l: [
      "-netdev dgram,id=${l.iface},local.type=inet,local.host=127.0.0.1,local.port=${toString l.localPort},remote.type=inet,remote.host=127.0.0.1,remote.port=${toString l.remotePort}"
      "-device virtio-net-pci,netdev=${l.iface},mac=${l.mac}"
    ]) myLinks;
  };

  networking = {
    hostName = name;
    useDHCP = false;
    useNetworkd = true;
    nameservers = lib.optional (dcName != null) (lo dcName);
    nftables.enable = true;
    firewall = {
      allowedTCPPorts = [ 22 179 53 80 ];
      allowedUDPPorts = [ 53 ];
      extraInputRules = "ip protocol 89 accept comment \"OSPF\"";
      # Multi-homing means asymmetric paths: strict reverse-path filtering would drop them.
      checkReversePath = "loose";
    };
  };
  services.resolved.enable = false;

  systemd.network = {
    links = {
      "10-mgmt" = { matchConfig.MACAddress = "52:54:00:12:34:56"; linkConfig.Name = "mgmt"; };
    } // lib.listToAttrs (map (l: lib.nameValuePair "10-${l.iface}" {
      matchConfig.MACAddress = l.mac;
      linkConfig.Name = l.iface;
    }) myLinks);
    netdevs = {
      "20-lo-svc".netdevConfig = { Name = "lo-svc"; Kind = "dummy"; };
      "20-lan0".netdevConfig = { Name = "lan0"; Kind = "dummy"; };
    };
    networks = {
      "10-mgmt" = {
        matchConfig.Name = "mgmt";
        networkConfig.DHCP = "ipv4";
        dhcpV4Config = { UseDNS = false; UseRoutes = false; UseGateway = false; };
      };
      "30-lo-svc" = { matchConfig.Name = "lo-svc"; address = [ "${lo name}/32" ]; };
      "30-lan0" = { matchConfig.Name = "lan0"; address = [ lan ] ++ extraLan; };
    } // lib.listToAttrs (map (l: lib.nameValuePair "20-${l.iface}" {
      matchConfig.Name = l.iface;
      address = [ "${l.local}/30" ];
      networkConfig.LinkLocalAddressing = "no";
    }) myLinks);
  };

  boot.kernel.sysctl = {
    "net.ipv4.ip_forward" = 1;
    "net.ipv4.conf.all.rp_filter" = 2;
    "net.ipv4.conf.default.rp_filter" = 2;
  };

  services.bird = {
    enable = true;
    checkConfig = false; # includes files from /var/lib/netagent
    config = ''
      router id ${lo name};
      log syslog all;

      protocol device { }

      protocol direct {
        ipv4;
        interface "lo-svc", "lan0";
      }

      protocol kernel {
        ipv4 {
          export filter {
            if source = RTS_DEVICE then reject;
            # Source traffic from the LAN address: loopbacks are not routable upstream.
            if dest = RTD_UNICAST then krt_prefsrc = ${lib.head (lib.splitString "/" lan)};
            accept;
          };
        };
      }

      include "/var/lib/netagent/*.conf";
    '';
  };

  environment.etc = lib.mapAttrs' (f: text: lib.nameValuePair "netagent/baseline/${f}" { inherit text; }) baselineFiles;

  systemd.services.netagent-seed = {
    wantedBy = [ "multi-user.target" ];
    before = [ "bird.service" ];
    requiredBy = [ "bird.service" ];
    serviceConfig = { Type = "oneshot"; RemainAfterExit = true; };
    script = ''
      install -d -m 0755 -g bird /var/lib/netagent
      for f in /etc/netagent/baseline/*.conf; do
        dst=/var/lib/netagent/$(basename "$f")
        [ -f "$dst" ] && [ ! -L "$dst" ] || install -m 0644 -g bird "$f" "$dst"
      done
    '';
  };
  systemd.services.bird.serviceConfig.ReadOnlyPaths = [ "/var/lib/netagent" ];

  services.unbound = lib.mkIf (lib.elem "dns" (me.services or [ ])) {
    enable = true;
    settings.server = {
      interface = [ (lo name) "127.0.0.1" ];
      access-control = [ "10.0.0.0/8 allow" "172.16.0.0/12 allow" "127.0.0.0/8 allow" ];
      local-zone = [ "\"lab.\" static" ];
      local-data = lib.mapAttrsToList (n: r: "\"${n}.lab. A 10.0.255.${toString r.id}\"") t.routers
        ++ [ "\"app.lab. A 10.100.${ids name}.10\"" ];
    };
  };
  systemd.services.unbound = lib.mkIf (lib.elem "dns" (me.services or [ ])) {
    after = [ "systemd-networkd-wait-online.service" ];
    wants = [ "systemd-networkd-wait-online.service" ];
  };

  services.nginx = lib.mkIf (lib.elem "web" (me.services or [ ])) {
    enable = true;
    virtualHosts.app = {
      default = true;
      locations."/".return = "200 'netmedic demo app: OK\\n'";
    };
  };

  environment.systemPackages = with pkgs; [
    (writeShellScriptBin "lab-reset" ''
      set -e
      for f in /etc/netagent/baseline/*.conf; do
        install -m 0644 -g bird "$f" "/var/lib/netagent/$(basename "$f")"
      done
      for t in hardening chaos; do nft delete table inet "$t" 2>/dev/null || true; done
      for i in /sys/class/net/to-*; do
        ip link set "$(basename "$i")" mtu 1500 up
      done
      systemctl start unbound nginx 2>/dev/null || true
      birdc configure
    '')
    traceroute
    dnsutils
    tcpdump
    mtr
    nftables
    curl
  ];

  services.openssh = {
    enable = true;
    authorizedKeysFiles = [ "/mnt/lab/authorized_keys" ];
    settings = { PermitRootLogin = "prohibit-password"; StrictModes = false; };
  };
  services.getty.autologinUser = "root";
  system.stateVersion = "25.11";
}
