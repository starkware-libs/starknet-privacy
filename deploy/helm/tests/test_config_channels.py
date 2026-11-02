"""Regression checks for how the privacy-starknet chart delivers configuration.

Run from the repository root: python3 -m unittest discover -s deploy/helm/tests -v
Requires `helm` on PATH (or HELM=/path/to/helm) and PyYAML.
"""

import base64
import copy
import os
import subprocess
import tempfile
import tomllib
import unittest

import yaml

CHART_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "privacy-starknet")
CI_VALUES = os.path.join(CHART_DIR, "ci", "default-values.yaml")
HELM = os.environ.get("HELM", "helm")

# `helm template ci ...` names every resource with this prefix.
DISCOVERY = "ci-privacy-starknet-discovery-service"
PROVER = "ci-privacy-starknet-transaction-prover"
PROOF_INTERCEPTOR_ENV = "ci-privacy-starknet-proof-interceptor"

# `$$` and `$(NAME)` would be rewritten by Kubernetes in a container `env` entry, and the
# discovery loader expands `${VAR}` in its file; the file must carry all of them as typed.
DISCOVERY_EDGE_VALUES = {
    "discoveryService": {
        "port": 9090,
        "config": {
            "rpcUrl": 'http://rpc/"quoted"\\back\\slash/${HOME}/$PATH/${UNSET:-fallback}/\x7f\x01é',
            "wsUrl": "wss://ws.synthetic.invalid/$(API_HOST)/$$literal",
            "rustLog": "info,discovery_service=debug",
            "api": {"health_max_lag_secs": 30},
        },
    }
}


# With the sidecar off, the prover has no GET health route for the GKE BackendConfig to check.
SIDECAR_DISABLED = {
    "transactionProver": {"proofInterceptor": {"enabled": False}, "backendConfig": {"enabled": False}}
}


def deep_merge(base, override):
    merged = copy.deepcopy(base)
    for key, value in override.items():
        if isinstance(value, dict) and isinstance(merged.get(key), dict):
            merged[key] = deep_merge(merged[key], value)
        else:
            merged[key] = copy.deepcopy(value)
    return merged


def helm_template(values=None):
    """Returns (returncode, stdout, stderr) of `helm template` over the CI values."""
    with tempfile.NamedTemporaryFile("w", suffix=".yaml", delete=False) as values_file:
        yaml.safe_dump(values or {}, values_file, allow_unicode=True)
    try:
        result = subprocess.run(
            [HELM, "template", "ci", CHART_DIR, "-n", "ci", "-f", CI_VALUES, "-f", values_file.name],
            capture_output=True,
            text=True,
        )
    finally:
        os.unlink(values_file.name)
    return result.returncode, result.stdout, result.stderr


def render(values=None):
    """Renders the chart and returns its resources keyed by (kind, name)."""
    returncode, stdout, stderr = helm_template(values)
    if returncode != 0:
        raise AssertionError(f"helm template failed: {stderr}")
    documents = [document for document in yaml.safe_load_all(stdout) if document]
    return {(document["kind"], document["metadata"]["name"]): document for document in documents}


def pod_annotations(resources, deployment_name):
    return resources[("Deployment", deployment_name)]["spec"]["template"]["metadata"].get(
        "annotations", {}
    )


def container(resources, deployment_name, container_name):
    containers = resources[("Deployment", deployment_name)]["spec"]["template"]["spec"]["containers"]
    return next(entry for entry in containers if entry["name"] == container_name)


def discovery_toml(resources):
    return resources[("ConfigMap", DISCOVERY)]["data"]["config.toml"]


class DiscoveryConfigTest(unittest.TestCase):
    def test_file_carries_settings_with_their_types(self):
        config = tomllib.loads(discovery_toml(render(DISCOVERY_EDGE_VALUES)))
        expected = DISCOVERY_EDGE_VALUES["discoveryService"]["config"]
        # The whole file, so any added field (an API host, a secret) fails the test.
        self.assertEqual(
            config,
            {
                "rpc": {"url": expected["rpcUrl"]},
                "indexer": {"ws_url": expected["wsUrl"]},
                "api": {"health_max_lag_secs": 30},
                "logging": {"level": expected["rustLog"]},
                "ohttp": {"enabled": True},
            },
        )
        self.assertIs(type(config["api"]["health_max_lag_secs"]), int)

    def test_file_has_no_placeholder_for_the_loader_to_expand(self):
        self.assertNotIn("$", discovery_toml(render(DISCOVERY_EDGE_VALUES)))

    def test_env_keeps_only_api_host_and_ohttp_key(self):
        environment = container(render(DISCOVERY_EDGE_VALUES), DISCOVERY, "discovery-service")["env"]
        self.assertEqual([entry["name"] for entry in environment], ["API_HOST", "OHTTP_KEY"])
        self.assertEqual(environment[0]["value"], "0.0.0.0:9090")

    def test_ohttp_disabled_omits_section_and_key(self):
        resources = render({"discoveryService": {"ohttp": {"enabled": False}}})
        self.assertNotIn("ohttp", tomllib.loads(discovery_toml(resources)))
        environment = container(resources, DISCOVERY, "discovery-service")["env"]
        self.assertEqual([entry["name"] for entry in environment], ["API_HOST"])


class ChecksumTest(unittest.TestCase):
    def test_each_payload_change_rolls_only_its_deployment(self):
        baseline = render()
        discovery_changed = render({"discoveryService": {"config": {"rustLog": "debug"}}})
        prover_changed = render({"transactionProver": {"config": {"max_concurrent_requests": 3}}})
        self.assertNotEqual(
            pod_annotations(discovery_changed, DISCOVERY), pod_annotations(baseline, DISCOVERY)
        )
        self.assertEqual(pod_annotations(discovery_changed, PROVER), pod_annotations(baseline, PROVER))
        self.assertNotEqual(pod_annotations(prover_changed, PROVER), pod_annotations(baseline, PROVER))
        self.assertEqual(pod_annotations(prover_changed, DISCOVERY), pod_annotations(baseline, DISCOVERY))

    def test_identical_renders_give_identical_checksums(self):
        first_render, second_render = render(), render()
        for deployment_name in (DISCOVERY, PROVER):
            annotations = pod_annotations(first_render, deployment_name)
            self.assertRegex(annotations.get("checksum/config", ""), "^[0-9a-f]{64}$")
            self.assertEqual(annotations, pod_annotations(second_render, deployment_name))

    def test_disabled_sidecar_settings_do_not_change_checksums(self):
        disabled = SIDECAR_DISABLED
        changed = deep_merge(
            disabled,
            {
                "transactionProver": {
                    "proofInterceptor": {
                        "port": 9999,
                        "screening": {"timeoutMs": 1, "url": "https://other.synthetic.invalid"},
                        "blockingCheck": {"timeoutMillis": 1, "failOpen": True},
                    }
                }
            },
        )
        self.assertEqual(
            pod_annotations(render(changed), PROVER), pod_annotations(render(disabled), PROVER)
        )

    def test_sidecar_env_change_rolls_the_prover_through_the_env_checksum_only(self):
        baseline = render()
        changed = render({"transactionProver": {"proofInterceptor": {"screening": {"timeoutMs": 1}}}})
        self.assertNotEqual(
            pod_annotations(changed, PROVER)["checksum/proof-interceptor-env"],
            pod_annotations(baseline, PROVER)["checksum/proof-interceptor-env"],
        )
        self.assertEqual(
            pod_annotations(changed, PROVER)["checksum/config"],
            pod_annotations(baseline, PROVER)["checksum/config"],
        )
        self.assertEqual(pod_annotations(changed, DISCOVERY), pod_annotations(baseline, DISCOVERY))

    def test_shared_rpc_url_change_updates_both_prover_checksums(self):
        baseline = pod_annotations(render(), PROVER)
        changed = pod_annotations(
            render({"transactionProver": {"config": {"rpc_node_url": "http://other.synthetic.invalid"}}}),
            PROVER,
        )
        self.assertNotEqual(changed["checksum/config"], baseline["checksum/config"])
        self.assertNotEqual(
            changed["checksum/proof-interceptor-env"], baseline["checksum/proof-interceptor-env"]
        )


class ProofInterceptorEnvTest(unittest.TestCase):
    def test_configmap_holds_every_setting_as_a_string(self):
        resources = render(
            {
                "transactionProver": {
                    "config": {"rpc_node_url": 'http://node.synthetic.invalid/"q"\\path'},
                    "proofInterceptor": {
                        "port": 9091,
                        "screening": {
                            # Kubernetes rewrites `$(PORT)` and `$$` in `env` entries, never in envFrom.
                            "url": "https://screening.synthetic.invalid/$(PORT)/$$",
                            "poolAddress": "0x123",
                            "anonymizerAddress": "0x456",
                            "failOpen": True,
                            "timeoutMs": 1234,
                            "maxRetries": 0,
                        },
                    },
                }
            }
        )
        self.assertEqual(
            resources[("ConfigMap", PROOF_INTERCEPTOR_ENV)]["data"],
            {
                "PORT": "9091",
                "SCREENING_URL": "https://screening.synthetic.invalid/$(PORT)/$$",
                "SCREENING_POOL_ADDRESS": "0x123",
                "SCREENING_ANONYMIZER_ADDRESS": "0x456",
                "SCREENING_FAIL_OPEN": "true",
                "SCREENING_TIMEOUT_MS": "1234",
                "SCREENING_MAX_RETRIES": "0",
                "SCREENING_RPC_URL": 'http://node.synthetic.invalid/"q"\\path',
            },
        )

    def test_sidecar_reads_configmap_and_maps_credential_keys(self):
        sidecar = container(
            render(
                {"transactionProver": {"proofInterceptor": {"screening": {"existingSecret": "synthetic-screening"}}}}
            ),
            PROVER,
            "proof-interceptor",
        )
        self.assertEqual(sidecar["envFrom"], [{"configMapRef": {"name": PROOF_INTERCEPTOR_ENV}}])
        self.assertEqual(
            sidecar["env"],
            [
                {
                    "name": "SCREENING_PARTNER_NAME",
                    "valueFrom": {"secretKeyRef": {"name": "synthetic-screening", "key": "partner-name"}},
                },
                {
                    "name": "SCREENING_PARTNER_SECRET",
                    "valueFrom": {"secretKeyRef": {"name": "synthetic-screening", "key": "partner-secret"}},
                },
            ],
        )

    def test_disabled_sidecar_renders_and_references_no_env_configmap(self):
        returncode, stdout, stderr = helm_template(SIDECAR_DISABLED)
        self.assertEqual(returncode, 0, stderr)
        self.assertNotIn(PROOF_INTERCEPTOR_ENV, stdout)
        self.assertNotIn("checksum/proof-interceptor-env", pod_annotations(render(SIDECAR_DISABLED), PROVER))


class CredentialAndGuardTest(unittest.TestCase):
    def test_configmaps_exclude_ohttp_keys(self):
        prover_key, discovery_key = "SYNTHETIC-PROVER-OHTTP-KEY", "SYNTHETIC-DISCOVERY-OHTTP-KEY"
        resources = render(
            {
                "transactionProver": {"ohttp": {"key": prover_key}},
                "discoveryService": {"ohttp": {"key": discovery_key}},
            }
        )
        configmaps = [resource for (kind, _), resource in resources.items() if kind == "ConfigMap"]
        self.assertEqual(len(configmaps), 3)
        for configmap in configmaps:
            rendered = yaml.safe_dump(configmap)
            for key in (prover_key, discovery_key):
                self.assertNotIn(key, rendered)
                self.assertNotIn(base64.b64encode(key.encode()).decode(), rendered)

    def test_required_guards_fail_with_their_messages(self):
        cases = {
            "transactionProver.proofInterceptor.screening.anonymizerAddress is required when proofInterceptor is enabled": {
                "transactionProver": {"proofInterceptor": {"screening": {"anonymizerAddress": ""}}}
            },
            "discoveryService.config.rpcUrl is required": {"discoveryService": {"config": {"rpcUrl": ""}}},
            "discoveryService.config.wsUrl is required": {"discoveryService": {"config": {"wsUrl": ""}}},
        }
        for message, values in cases.items():
            with self.subTest(message=message):
                returncode, _, stderr = helm_template(values)
                self.assertNotEqual(returncode, 0)
                self.assertIn(message, stderr)

    def test_disabled_sidecar_does_not_require_its_settings(self):
        returncode, _, stderr = helm_template(
            deep_merge(SIDECAR_DISABLED, {"transactionProver": {"proofInterceptor": {"screening": {"anonymizerAddress": ""}}}})
        )
        self.assertEqual(returncode, 0, stderr)


if __name__ == "__main__":
    unittest.main()
