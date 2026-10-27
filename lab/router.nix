# One lab router, run as a local QEMU VM. BIRD's base config is declarative (read-only in
# /nix/store); BGP sessions live in /var/lib/netagent/*.conf, the only place netmedic (and the
# chaos script) may modify.
{ name, topology }:
{ config, lib, pkgs, modulesPath, ... }:
let
  t = topology;
  me = t.routers.${name};
  dnsRouter = lib.findFirst (r: r.dns or false) null (lib.attrValues t.routers);
  dnsIp = "10.0.255.${toString dnsRouter.id}";
  udpPort = linkId: id: 40000 + linkId * 10 + id;

  # Links this router is part of, with both ends resolved.
  myLinks = lib.concatMap
    (pair:
      let
        a = t.routers.${lib.elemAt pair 0};
        b = t.routers.${lib.elemAt pair 1};
        lo = if a.id < b.id then a else b;
        hi = if a.id < b.id then b else a;
        linkId = 10 * lo.id + hi.id;
        peerName = if lib.elemAt pair 0 == name then lib.elemAt pair 1 else lib.elemAt pair 0;
        peer = t.routers.${peerName};
        mine = if me.id == lo.id then 1 else 2;
      in
      lib.optional (lib.elem name pair) {
        inherit peerName;
        peerAsn = peer.asn;
        iface = "to-${peerName}";
        mac = "52:54:00:ab:${toString linkId}:0${toString me.id}";
        localPort = udpPort linkId me.id;
        remotePort = udpPort linkId peer.id;
        local = "172.16.${toString linkId}.${toString mine}";
        remote = "172.16.${toString linkId}.${toString (3 - mine)}";
      })
    t.links;

  bgpBaseline = lib.concatMapStrings (l: ''
    protocol bgp bgp_${l.peerName} {
      description "eBGP to ${l.peerName}";
      local ${l.local} as ${toString me.asn};
      neighbor ${l.remote} as ${toString l.peerAsn};
      hold time 9;
      keepalive time 3;
      connect retry time 5;
      error wait time 2, 10; # fast recovery for the demo
      ipv4 {
        import filter import_peer;
        export filter export_peer;
      };
    }

  '') myLinks;
in
{
  imports = [ "${modulesPath}/virtualisation/qemu-vm.nix" ];

  virtualisation = {
    memorySize = 512;
    cores = 1;
    graphics = false;
    diskImage = null; # stateless: every boot starts from the baseline
    forwardPorts = [{ from = "host"; host.address = "127.0.0.1"; host.port = 2220 + me.id; guest.port = 22; }];
    # authorized_keys is provided at runtime by lab.sh ($LAB_STATE), never committed.
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
    nameservers = [ dnsIp ];
    nftables.enable = true;
    firewall = {
      allowedTCPPorts = [ 22 179 53 ];
      allowedUDPPorts = [ 53 ];
    };
  };

  systemd.network = {
    links = {
      "10-mgmt" = { matchConfig.MACAddress = "52:54:00:12:34:56"; linkConfig.Name = "mgmt"; };
    } // lib.listToAttrs (map (l: lib.nameValuePair "10-${l.iface}" {
      matchConfig.MACAddress = l.mac;
      linkConfig.Name = l.iface;
    }) myLinks);
    netdevs."20-lo-svc".netdevConfig = { Name = "lo-svc"; Kind = "dummy"; };
    networks = {
      "10-mgmt" = {
        matchConfig.Name = "mgmt";
        networkConfig.DHCP = "ipv4";
        dhcpV4Config.UseDNS = false;
      };
      "30-lo-svc" = {
        matchConfig.Name = "lo-svc";
        address = [ "10.0.255.${toString me.id}/32" "10.100.${toString me.id}.1/24" ];
      };
    } // lib.listToAttrs (map (l: lib.nameValuePair "20-${l.iface}" {
      matchConfig.Name = l.iface;
      address = [ "${l.local}/30" ];
      networkConfig.LinkLocalAddressing = "no";
    }) myLinks);
  };

  boot.kernel.sysctl."net.ipv4.ip_forward" = 1;

  services.bird = {
    enable = true;
    checkConfig = false; # includes files from /var/lib/netagent, not available at build time
    config = ''
      router id 10.0.255.${toString me.id};
      log syslog all;

      protocol device { }

      protocol direct {
        ipv4;
        interface "lo-svc";
      }

      protocol kernel {
        ipv4 {
          export filter {
            if source != RTS_BGP then reject;
            krt_prefsrc = 10.0.255.${toString me.id}; # traffic sourced from the loopback
            accept;
          };
        };
      }

      # Accept lab space only, never default route or p2p subnets.
      filter import_peer {
        if net ~ [ 10.0.0.0/8{8,32} ] then accept;
        reject;
      }

      filter export_peer {
        if net ~ [ 10.0.0.0/8{8,32} ] then accept;
        reject;
      }

      include "/var/lib/netagent/*.conf";
    '';
  };

  environment.etc."netagent/baseline/bgp.conf".text = bgpBaseline;

  # Seed the agent-managed config from the baseline at boot.
  systemd.tmpfiles.rules = [
    "d /var/lib/netagent 0755 root bird -"
    "C /var/lib/netagent/bgp.conf 0644 root bird - /etc/netagent/baseline/bgp.conf"
  ];
  systemd.services.bird = {
    after = [ "systemd-tmpfiles-setup.service" ];
    serviceConfig.ReadOnlyPaths = [ "/var/lib/netagent" ];
  };

  services.unbound = lib.mkIf (me.dns or false) {
    enable = true;
    settings.server = {
      interface = [ dnsIp "127.0.0.1" ];
      access-control = [ "10.0.0.0/8 allow" "172.16.0.0/12 allow" "127.0.0.0/8 allow" ];
      local-zone = [ "\"lab.\" static" ];
      local-data = lib.mapAttrsToList
        (n: r: "\"${n}.lab. A 10.0.255.${toString r.id}\"") t.routers
        ++ [ "\"app.lab. A 10.100.1.10\"" ];
    };
  };
  # unbound binds the loopback address carried by lo-svc
  systemd.services.unbound = lib.mkIf (me.dns or false) {
    after = [ "systemd-networkd-wait-online.service" ];
    wants = [ "systemd-networkd-wait-online.service" ];
  };

  environment.systemPackages = with pkgs; [
    (writeShellScriptBin "lab-reset" ''
      set -e
      cp /etc/netagent/baseline/bgp.conf /var/lib/netagent/bgp.conf
      rm -f /var/lib/netagent/chaos-*.conf
      nft delete table inet chaos 2>/dev/null || true
      for i in /sys/class/net/to-*; do
        ip link set "$(basename "$i")" mtu 1500 up
      done
      birdc configure
    '')
    traceroute
    dnsutils
    tcpdump
    mtr
    nftables
  ];

  services.openssh = {
    enable = true;
    authorizedKeysFiles = [ "/mnt/lab/authorized_keys" ];
    settings = {
      PermitRootLogin = "prohibit-password";
      StrictModes = false; # authorized_keys lives on a 9p share owned by the host user
    };
  };
  services.getty.autologinUser = "root"; # serial console, for debugging only

  system.stateVersion = "25.11";
}
