<div align="center">
  <img alt="Cairo Logo" src="cairo_logo.png" width="200">
</div>

<div align="center">

[![License: Apache2.0](https://img.shields.io/badge/License-Apache2.0-green.svg)](LICENSE)
</div>

# Template Cairo Repo

## Title

[Website](link-to-website) | [Docs](link-to-docs)

## Content

- [Overview](#overview)
- [Dependencies](#dependencies)
- [Installation](#installation)
- [Getting help](#getting-help)
- [Build and Test](#build-and-test)
- [Audit](#audit)
- [Security](#security)

## Overview

This a template repo for new Cairo projects, use this repo as a start.
You can fork the repo or start a new repo and do the following:

In this repo run

```bash
git clone https://github.com/starkware-libs/template-cairo-repo.git
cd template-cairo-repo
git fetch origin
git format-patch 40b4468^..HEAD
```
This will create a file like 0001-Your-commit-message.patch.

In the new repo run
```bash
git clone https://github.com/username/new-repo.git
cd new-repo
git am ../template-cairo-repo/0001-Your-commit-message.patch
git push origin <branch-name>
```

Make sure to edit Scarb.toml to define workspace in this repo.


| Smart contract   | Description                                                                                                                            |
|------------------|----------------------------------------------------------------------------------------------------------------------------------------|
| [Smart Contract 1](packages/smart_contract_1)             | Smart contract 1 description                                                                                                 |
| [Smart Contract 2](packages/smart_Contract_2)          | Smart contract 2 description                                                        |
| [ETC...](packages/etc)       | Etc...                                                                  |

## Dependencies

- Cairo dependencies such as [Scarb](https://docs.swmansion.com/scarb/) and [Starknet foundry](https://foundry-rs.github.io/starknet-foundry/index.html) - install using [starkup](https://github.com/software-mansion/starkup).

## Installation

Clone the repo and from within the projects root folder run:

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.starkup.dev | sh
```

### Starknet Devnet

This project uses a [custom fork of starknet-devnet](https://github.com/m-kus/starknet-devnet) that includes a blockifier version supporting the new transaction version with proofs. Install from the `APOLLO-PRE-PROOF-DEMO-11` release:

If you have a previous asdf installation of starknet-devnet, remove it first:

```bash
asdf plugin remove starknet-devnet
```

Then install from the release:

```bash
# macOS (Apple Silicon)
curl -L https://github.com/m-kus/starknet-devnet/releases/download/APOLLO-PRE-PROOF-DEMO-11/starknet-devnet-aarch64-apple-darwin.tar.gz -o /tmp/starknet-devnet.tar.gz
sudo tar -xzf /tmp/starknet-devnet.tar.gz -C /usr/local/bin
sudo chmod +x /usr/local/bin/starknet-devnet
rm /tmp/starknet-devnet.tar.gz

# Linux (x86_64)
curl -L https://github.com/m-kus/starknet-devnet/releases/download/APOLLO-PRE-PROOF-DEMO-11/starknet-devnet-x86_64-unknown-linux-gnu.tar.gz -o /tmp/starknet-devnet.tar.gz
sudo tar -xzf /tmp/starknet-devnet.tar.gz -C /usr/local/bin
sudo chmod +x /usr/local/bin/starknet-devnet
rm /tmp/starknet-devnet.tar.gz
```

Verify the installation:

```bash
which starknet-devnet
# Expected: /usr/local/bin/starknet-devnet
```

## Getting help

Reach out to the maintainer at any of the following:

- [GitHub Discussions](discussions)
- Contact options listed on this [GitHub profile](https://github.com/starkware-libs)

## Build and Test

Build the contracts from the repo root:

```bash
scarb build

```

To run the tests, execute:

```bash
scarb test
```

## Audit

Find the latest audit report in [docs/audit](docs/audit).

## Security

This repo follows good practices of security, but 100% security cannot be assured. This repo is provided "as is" without any warranty. Use at your own risk.

For more information and to report security issues, please refer to our [security documentation](docs/SECURITY.md).
