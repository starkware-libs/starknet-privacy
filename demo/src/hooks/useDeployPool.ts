import { useState, useCallback, useMemo } from "react";
import { Account, type RpcProvider } from "starknet";
import type { AccountConfig, AppConfig } from "../config.ts";

export function useDeployPool(
  provider: RpcProvider | undefined,
  config: AppConfig,
  accounts: AccountConfig[],
) {
  const [deploying, setDeploying] = useState(false);
  const [deployError, setDeployError] = useState<string | null>(null);

  const adminConfig = useMemo(() => accounts.find((a) => a.admin), [accounts]);

  const adminAccount = useMemo(() => {
    if (!provider || !adminConfig) return undefined;
    return new Account({
      provider,
      address: adminConfig.address,
      signer: adminConfig.privateKey,
      cairoVersion: "1",
    });
  }, [provider, adminConfig]);

  const deploy = useCallback(async (): Promise<{ address: string; txHash: string }> => {
    if (!adminAccount || !adminConfig || !provider) throw new Error("Provider not ready");
    setDeploying(true);
    setDeployError(null);

    try {
      const salt = `0x${Date.now().toString(16)}`;
      const constructorCalldata = [
        adminConfig.address,
        config.compliancePublicKey,
        config.proofValidityBlocks,
      ];

      const deployFee = await adminAccount.estimateDeployFee({
        classHash: config.poolClassHash,
        constructorCalldata,
        salt,
      });
      const deployResult = await adminAccount.deployContract(
        { classHash: config.poolClassHash, constructorCalldata, salt },
        { tip: 0n, resourceBounds: deployFee.resourceBounds },
      );

      const receipt = await provider.waitForTransaction(
        deployResult.transaction_hash,
      );
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
  }, [adminAccount, adminConfig, provider, config]);

  return { deploying, deployError, deploy };
}
