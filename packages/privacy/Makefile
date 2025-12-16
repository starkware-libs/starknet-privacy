POOL_CLASS_HASH=0xe2eb8f5672af4e6a4e8a8f1b44989685e668489b0a25437733756c5a34a1d6
POOL_ADDRESS=0x0619381f2a6cea1947476087af835c48a99ba9385f07dae557112111e3236043

USDC_CLASS_HASH=0x017bb1e099fddc1c227cf479a3488554755d167efa9ce689a5199431eeab176a
USDC_ADDRESS=0x03e2c7685b91fbf41708365da7dd099b18a6628fdbf4c4834c6a871117eb2983

install-devnet:
	asdf plugin add starknet-devnet
	asdf install starknet-devnet 0.7.1

devnet:
	starknet-devnet --accounts=2 --seed=0 --initial-balance=100000000000000000000000

accounts-file:
	curl -s -X POST -H "Content-Type: application/json" \
		--data '{"jsonrpc":"2.0","id":"1","method":"devnet_getPredeployedAccounts"}' http://127.0.0.1:5050/ \
		| jq '{"alpha-sepolia": {"devnet0": {\
			address: .result[0].address, \
			private_key: .result[0].private_key, \
			public_key: .result[0].public_key, \
			class_hash: "0xe2eb8f5672af4e6a4e8a8f1b44989685e668489b0a25437733756c5a34a1d6", \
			deployed: true, \
			legacy: false, \
			salt: "0x14", \
			type: "open_zeppelin"\
		}, "devnet1": {\
			address: .result[1].address, \
			private_key: .result[1].private_key, \
			public_key: .result[1].public_key, \
			class_hash: "0xe2eb8f5672af4e6a4e8a8f1b44989685e668489b0a25437733756c5a34a1d6", \
			deployed: true, \
			legacy: false, \
			salt: "0x14", \
			type: "open_zeppelin"\
		}}}' > ./accounts.json

declare:
	sncast declare --package server --contract-name Server

deploy:
	# TODO: use class hash from the result of the `make declare` step
	sncast deploy --salt 0x00 --class-hash $(POOL_CLASS_HASH)

register:
	sncast invoke \
		--contract-address $(POOL_ADDRESS) \
		--function register \
		--calldata $(shell jq -r '.["alpha-sepolia"].devnet0.public_key' ./accounts.json)

get-public-key:
	sncast call \
		--contract-address $(POOL_ADDRESS) \
		--function get_public_key \
		--calldata $(shell jq -r '.["alpha-sepolia"].devnet0.address' ./accounts.json)

usdc-declare:
	sncast declare-from \
		--class-hash $(USDC_CLASS_HASH) \
		--source-network mainnet

usdc-deploy:
	ADMIN=$(shell jq -r '.["alpha-sepolia"].devnet0.address' ./accounts.json) ; \
	export ADMIN ; \
	sncast deploy \
		--salt 0x00 \
		--class-hash $(USDC_CLASS_HASH) \
		--arguments "\"USDC\", \"USDC\", 2, $$ADMIN, $$ADMIN, $$ADMIN, $$ADMIN, $$ADMIN, $$ADMIN"

usdc-configure:
	ADMIN=$(shell jq -r '.["alpha-sepolia"].devnet0.address' ./accounts.json) ; \
	export ADMIN ; \
	sncast invoke \
		--contract-address $(USDC_ADDRESS) \
		--function configure_controller \
		--arguments "$$ADMIN, $$ADMIN" ; \
	sncast invoke \
		--contract-address $(USDC_ADDRESS) \
		--function configure_minter \
		--arguments "1000000000000000000000000"

usdc-mint:
	TO=$(shell jq -r '.["alpha-sepolia"].devnet0.address' ./accounts.json) ; \
	export TO ; \
	sncast invoke \
		--contract-address $(USDC_ADDRESS) \
		--function mint \
		--arguments "$$TO, 1000000000"

usdc-approve:
	sncast invoke \
		--contract-address $(USDC_ADDRESS) \
		--function approve \
		--arguments "$(POOL_ADDRESS), 1000000000"

deposit:
	USER=$(shell jq -r '.["alpha-sepolia"].devnet0.address' ./accounts.json) ; \
	export USER ; \
	sncast invoke \
		--contract-address $(POOL_ADDRESS) \
		--function deposit \
		--calldata $$USER $(USDC_ADDRESS) 0x3b9aca00 0x01 0x01

transfer:
	sncast invoke \
		--contract-address $(POOL_ADDRESS) \
		--function transfer \
		--calldata 1 0x01 1 0x02 0x02 # one nullifier, one new note

withdraw:
	USER=$(shell jq -r '.["alpha-sepolia"].devnet0.address' ./accounts.json) ; \
	export USER ; \
	sncast invoke \
		--contract-address $(POOL_ADDRESS) \
		--function withdraw \
		--calldata $$USER $(USDC_ADDRESS) 0x3b9aca00 0x02

open-channel:
	RECIPIENT=$(shell jq -r '.["alpha-sepolia"].devnet1.address' ./accounts.json) ; \
	export RECIPIENT ; \
	sncast invoke \
		--contract-address $(POOL_ADDRESS) \
		--function open_channel \
		--calldata $$RECIPIENT 0x01 0x02 0x03 0x04 0x05
