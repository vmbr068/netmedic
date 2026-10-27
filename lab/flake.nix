{
  description = "netmedic demo lab: NixOS + BIRD routers as local QEMU VMs";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { self, nixpkgs }:
    let
      topology = import ./topology.nix;
      mkRouter = name: nixpkgs.lib.nixosSystem {
        system = "x86_64-linux";
        modules = [ (import ./router.nix { inherit name topology; }) ];
      };
    in
    {
      nixosConfigurations = nixpkgs.lib.mapAttrs (name: _: mkRouter name) topology.routers;

      # nix build ./lab#vm-r1 -> result/bin/run-r1-vm
      packages.x86_64-linux = nixpkgs.lib.mapAttrs'
        (name: sys: nixpkgs.lib.nameValuePair "vm-${name}" sys.config.system.build.vm)
        self.nixosConfigurations;
    };
}
