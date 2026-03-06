import { useState, useCallback, useMemo } from "react";
import { Account, type RpcProvider } from "starknet";
import type { AppConfig } from "../config.ts";
import { DEPLOY_RESOURCE_BOUNDS } from "../starknet.ts";

export function useDeployPool(provider: RpcProvider | undefined, config: AppConfig) {
  const [deploying, setDeploying] = useState(false);
  const [deployError, setDeployError] = useState<string | null>(null);

  const adminAccount = useMemo(() => {
    if (!provider) return undefined;
    return new Account({
      provider,
      address: config.adminAddress,
      signer: config.adminKey,
      cairoVersion: "1",
    });
  }, [provider, config.adminAddress, config.adminKey]);

  const deploy = useCallback(async (): Promise<{ address: string; txHash: string }> => {
    if (!adminAccount || !provider) throw new Error("Provider not ready");
    setDeploying(true);
    setDeployError(null);

    try {
      const salt = `0x${Date.now().toString(16)}`;
      const constructorCalldata = [
        config.adminAddress,
        config.compliancePublicKey,
        config.proofValidityBlocks,
      ];

      const deployResult = await adminAccount.deployContract(
        { classHash: config.poolClassHash, constructorCalldata, salt },
        { tip: 0n, resourceBounds: DEPLOY_RESOURCE_BOUNDS }
      );

      const receipt = await provider.waitForTransaction(deployResult.transaction_hash);
      if (!receipt.isSuccess()) {
        throw new Error(`Deploy reverted: ${JSON.stringify(receipt)}`);
      }

      return {
        address: deployResult.contract_address,
        txHash: deployResult.transaction_hash,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setDeployError(message);
      throw error;
    } finally {
      setDeploying(false);
    }
  }, [adminAccount, provider, config]);

  return { deploying, deployError, deploy };
}
