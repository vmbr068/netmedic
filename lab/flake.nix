{
  description = "netmedic demo labs: NixOS + BIRD routers as local QEMU VMs";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { self, nixpkgs }:
    let
      lib = nixpkgs.lib;
      ring = import ./topology.nix;
      enterprise = import ./enterprise/topology.nix;
      mk = module: lib.nixosSystem { system = "x86_64-linux"; modules = [ module ]; };
      ringNodes = lib.mapAttrs (name: _: mk (import ./router.nix { inherit name; topology = ring; })) ring.routers;
      enterpriseNodes = lib.mapAttrs
        (name: _: mk (import ./enterprise/node.nix { inherit name; topology = enterprise; }))
        enterprise.routers;
    in
    {
      # "ring": 4 routers, eBGP ring (simple, fast demo). "enterprise": 8 routers, OSPF + iBGP RR +
      # dual-homed upstreams + branch (hard).
      nixosConfigurations = ringNodes // enterpriseNodes;

      # nix build ./lab#vm-<router> -> result/bin/run-<router>-vm
      packages.x86_64-linux = lib.mapAttrs'
        (name: sys: lib.nameValuePair "vm-${name}" sys.config.system.build.vm)
        self.nixosConfigurations;

      # Router metadata for lab.sh / netmedic inventory generation.
      topologies = lib.mapAttrs (_: topo: {
        inherit (topo) notes;
        targets = topo.targets or [ ];
        routers = lib.mapAttrs (n: r: { managed = true; role = "router"; layer = null; } // r) topo.routers;
      }) { inherit ring enterprise; };
    };
}
