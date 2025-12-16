# Server
Document overview of this package here.

## Devnet deployment

Run devnet:
```sh
make devnet
```

Generate account file (used by snfoundry default profile):
```sh
make accounts-file
```

Declare contract class:
```sh
make declare
```

Change class hash if needed, then:
```sh
make deploy
```

### USDC token

Declare from mainnet:
```sh
make usdc-declare
```

Deploy an instance controlled by the default account:
```sh
make usdc-deploy
```

Configure minter:
```sh
make usdc-configure
```

Mint to self:
```sh
make usdc-mint
```

### Open channel

Update encrypted channel info and ID and run:
```sh
make open-channel
```

### Deposit

Set allowance for the pool contract:
```sh
make usds-approve
```

Make a deposit (change note ID if needed):
```sh
make deposit
```

### Transfer

Make a transfer (change nullifier and note ID if needed):
```sh
make transfer
```

### Withdrawal

Make a withdrawal (change nullifier if needed):
```sh
make withdraw
```
