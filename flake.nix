{
  description = "netmedic — autonomous network incident remediation agent";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { self, nixpkgs }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" ];
      forAll = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
    in
    {
      devShells = forAll (pkgs: {
        default = pkgs.mkShell {
          packages = [ pkgs.python312 pkgs.uv pkgs.openssh pkgs.sops pkgs.nodejs_22 ];
          env.UV_PYTHON_DOWNLOADS = "never";
          env.UV_PYTHON = "${pkgs.python312}/bin/python3";
        };
      });
    };
}
