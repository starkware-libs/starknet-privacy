"""Regression checks for how the privacy-starknet chart delivers configuration.

Run from the repository root: python3 -m unittest discover -s deploy/helm/tests -v
Requires `helm` on PATH (or HELM=/path/to/helm) and PyYAML.
"""

import copy
import hashlib
import os
import shutil
import subprocess
import tempfile
import tomllib
import unittest

import yaml

CHART_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "privacy-starknet")
CI_VALUES = os.path.join(CHART_DIR, "ci", "default-values.yaml")
HELM = os.environ.get("HELM", "helm")

# `$$` and `$(NAME)` would be rewritten by Kubernetes in a container `env` entry;
# the config file must carry them as typed.
DISCOVERY_EDGE_VALUES = {
    "discoveryService": {
        "config": {
            "rpcUrl": 'http://rpc/"quoted"\\back\\slash/${HOME}/$PATH/${UNSET:-fallback}',
            "wsUrl": "wss://ws.synthetic.invalid/$(API_HOST)/$$literal",
            "apiHost": "0.0.0.0:9090",
            "rustLog": "info,discovery_service=debug",
            "api": {"health_max_lag_secs": 30},
        }
    }
}


def deep_merge(base, override):
    merged = copy.deepcopy(base)
    for key, value in override.items():
        if isinstance(value, dict) and isinstance(merged.get(key), dict):
            merged[key] = deep_merge(merged[key], value)
        else:
            merged[key] = copy.deepcopy(value)
    return merged


def helm_template(values=None, chart_dir=CHART_DIR):
    """Returns (returncode, stdout, stderr) of `helm template` over the CI values."""
    with tempfile.NamedTemporaryFile("w", suffix=".yaml", delete=False) as values_file:
        yaml.safe_dump(values or {}, values_file, allow_unicode=True)
    try:
        result = subprocess.run(
            [HELM, "template", "ci", chart_dir, "-n", "ci", "-f", CI_VALUES, "-f", values_file.name],
            capture_output=True,
            text=True,
        )
    finally:
        os.unlink(values_file.name)
    return result.returncode, result.stdout, result.stderr


def render(values=None, chart_dir=CHART_DIR):
    """Renders the chart and returns its resources keyed by (kind, name)."""
    returncode, stdout, stderr = helm_template(values, chart_dir)
    if returncode != 0:
        raise AssertionError(f"helm template failed: {stderr}")
    documents = [document for document in yaml.safe_load_all(stdout) if document]
    return {(document["kind"], document["metadata"]["name"]): document for document in documents}


def pod_annotations(resources, deployment_name):
    return resources[("Deployment", deployment_name)]["spec"]["template"]["metadata"].get("annotations", {})


def container(resources, deployment_name, container_name):
    containers = resources[("Deployment", deployment_name)]["spec"]["template"]["spec"]["containers"]
    return next(entry for entry in containers if entry["name"] == container_name)


def discovery_toml(resources):
    return resources[("ConfigMap", "discovery-service-config")]["data"]["config.toml"]


class DiscoveryConfigTest(unittest.TestCase):
    def test_file_carries_settings_with_their_types(self):
        resources = render(DISCOVERY_EDGE_VALUES)
        config = tomllib.loads(discovery_toml(resources))
        expected = DISCOVERY_EDGE_VALUES["discoveryService"]["config"]
        self.assertEqual(config["rpc"]["url"], expected["rpcUrl"])
        self.assertEqual(config["indexer"]["ws_url"], expected["wsUrl"])
        self.assertEqual(config["logging"]["level"], expected["rustLog"])
        self.assertIs(type(config["api"]["health_max_lag_secs"]), int)
        self.assertEqual(config["api"]["health_max_lag_secs"], 30)
        self.assertIs(config["ohttp"]["enabled"], True)
        self.assertNotIn("host", config["api"])

    def test_file_has_no_placeholder_for_the_loader_to_expand(self):
        # The discovery loader expands ${VAR} in the raw text before parsing TOML.
        self.assertNotIn("$", discovery_toml(render(DISCOVERY_EDGE_VALUES)))

    def test_env_keeps_only_api_host_and_ohttp_key(self):
        environment = container(render(DISCOVERY_EDGE_VALUES), "discovery-service", "discovery-service")["env"]
        self.assertEqual([entry["name"] for entry in environment], ["API_HOST", "OHTTP_KEY"])
        self.assertEqual(environment[0]["value"], "0.0.0.0:9090")

    def test_ohttp_disabled_omits_section_and_key(self):
        resources = render({"discoveryService": {"ohttp": {"enabled": False}}})
        self.assertNotIn("ohttp", tomllib.loads(discovery_toml(resources)))
        environment = container(resources, "discovery-service", "discovery-service")["env"]
        self.assertEqual([entry["name"] for entry in environment], ["API_HOST"])

    def test_global_ohttp_disabled_omits_section(self):
        resources = render({"global": {"ohttp": {"enabled": False}}})
        self.assertNotIn("ohttp", tomllib.loads(discovery_toml(resources)))

    def test_component_ohttp_setting_overrides_global(self):
        resources = render({"global": {"ohttp": {"enabled": False}}, "discoveryService": {"ohttp": {"enabled": True}}})
        self.assertIs(tomllib.loads(discovery_toml(resources))["ohttp"]["enabled"], True)


class ChecksumTest(unittest.TestCase):
    def test_checksum_is_the_hash_of_the_consumed_payload(self):
        resources = render()
        payloads = {
            "discovery-service": discovery_toml(resources),
            "transaction-prover": resources[("ConfigMap", "transaction-prover-config")]["data"]["config.json"],
        }
        for deployment_name, payload in payloads.items():
            # The ConfigMap literal block adds one trailing newline to the payload.
            digest = hashlib.sha256(payload.removesuffix("\n").encode()).hexdigest()
            self.assertEqual(pod_annotations(resources, deployment_name)["checksum/config"], digest)

    def test_each_payload_change_rolls_only_its_deployment(self):
        baseline = render()
        discovery_changed = render({"discoveryService": {"config": {"rustLog": "debug"}}})
        prover_changed = render({"transactionProver": {"config": {"max_concurrent_requests": 3}}})
        self.assertNotEqual(pod_annotations(discovery_changed, "discovery-service"), pod_annotations(baseline, "discovery-service"))
        self.assertEqual(pod_annotations(discovery_changed, "transaction-prover"), pod_annotations(baseline, "transaction-prover"))
        self.assertNotEqual(pod_annotations(prover_changed, "transaction-prover"), pod_annotations(baseline, "transaction-prover"))
        self.assertEqual(pod_annotations(prover_changed, "discovery-service"), pod_annotations(baseline, "discovery-service"))

    def test_identical_payloads_give_identical_checksums(self):
        first_render, second_render = render(), render()
        for deployment_name in ("discovery-service", "transaction-prover"):
            annotations = pod_annotations(first_render, deployment_name)
            self.assertRegex(annotations.get("checksum/config", ""), "^[0-9a-f]{64}$")
            self.assertEqual(annotations, pod_annotations(second_render, deployment_name))

    def test_chart_version_alone_does_not_change_checksums(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            bumped_chart = shutil.copytree(CHART_DIR, os.path.join(temporary_directory, "privacy-starknet"))
            chart_metadata_path = os.path.join(bumped_chart, "Chart.yaml")
            with open(chart_metadata_path) as chart_metadata_file:
                chart_metadata = yaml.safe_load(chart_metadata_file)
            chart_metadata["version"] = "99.0.0"
            with open(chart_metadata_path, "w") as chart_metadata_file:
                yaml.safe_dump(chart_metadata, chart_metadata_file)
            bumped = render(chart_dir=bumped_chart)
        baseline = render()
        deployment_key = ("Deployment", "discovery-service")
        self.assertNotEqual(bumped[deployment_key]["metadata"]["labels"], baseline[deployment_key]["metadata"]["labels"])
        for deployment_name in ("discovery-service", "transaction-prover"):
            self.assertEqual(pod_annotations(bumped, deployment_name), pod_annotations(baseline, deployment_name))

    def test_disabled_sidecar_settings_do_not_change_checksums(self):
        disabled = {"transactionProver": {"proofInterceptor": {"enabled": False}}}
        changed = deep_merge(disabled, {"transactionProver": {"proofInterceptor": {
            "port": 9999,
            "screening": {"timeoutMs": 1, "url": "https://other.synthetic.invalid"},
            "blockingCheck": {"timeoutMillis": 1, "failOpen": True},
        }}})
        self.assertEqual(pod_annotations(render(changed), "transaction-prover"), pod_annotations(render(disabled), "transaction-prover"))


class ProofInterceptorEnvTest(unittest.TestCase):
    def test_configmap_holds_every_setting_as_a_string(self):
        resources = render({"transactionProver": {
            "config": {"rpc_node_url": 'http://node.synthetic.invalid/"q"\\path'},
            "proofInterceptor": {"port": 9091, "screening": {
                # Kubernetes rewrites `$(PORT)` and `$$` in `env` entries, never in envFrom.
                "url": "https://screening.synthetic.invalid/$(PORT)/$$",
                "poolAddress": "0x123",
                "anonymizerAddress": "0x456",
                "failOpen": True,
                "timeoutMs": 1234,
                "maxRetries": 0,
            }},
        }})
        self.assertEqual(resources[("ConfigMap", "proof-interceptor-env")]["data"], {
            "PORT": "9091",
            "SCREENING_URL": "https://screening.synthetic.invalid/$(PORT)/$$",
            "SCREENING_POOL_ADDRESS": "0x123",
            "SCREENING_ANONYMIZER_ADDRESS": "0x456",
            "SCREENING_FAIL_OPEN": "true",
            "SCREENING_TIMEOUT_MS": "1234",
            "SCREENING_MAX_RETRIES": "0",
            "SCREENING_RPC_URL": 'http://node.synthetic.invalid/"q"\\path',
        })

    def test_sidecar_reads_configmap_and_maps_credential_keys(self):
        sidecar = container(
            render({"transactionProver": {"proofInterceptor": {"screeningSecretName": "synthetic-screening"}}}),
            "transaction-prover",
            "proof-interceptor",
        )
        self.assertEqual(sidecar["envFrom"], [{"configMapRef": {"name": "proof-interceptor-env"}}])
        self.assertEqual(sidecar["env"], [
            {"name": "SCREENING_PARTNER_NAME",
             "valueFrom": {"secretKeyRef": {"name": "synthetic-screening", "key": "partner-name"}}},
            {"name": "SCREENING_PARTNER_SECRET",
             "valueFrom": {"secretKeyRef": {"name": "synthetic-screening", "key": "partner-secret"}}},
        ])

    def test_disabled_sidecar_renders_and_references_no_env_configmap(self):
        returncode, stdout, stderr = helm_template({"transactionProver": {"proofInterceptor": {"enabled": False}}})
        self.assertEqual(returncode, 0, stderr)
        self.assertNotIn("proof-interceptor-env", stdout)

    def test_env_change_rolls_only_the_prover_through_the_env_checksum(self):
        baseline = render()
        changed = render({"transactionProver": {"proofInterceptor": {"screening": {"timeoutMs": 1}}}})
        self.assertNotEqual(
            pod_annotations(changed, "transaction-prover")["checksum/proof-interceptor-env"],
            pod_annotations(baseline, "transaction-prover")["checksum/proof-interceptor-env"],
        )
        self.assertEqual(
            pod_annotations(changed, "transaction-prover")["checksum/config"],
            pod_annotations(baseline, "transaction-prover")["checksum/config"],
        )
        self.assertEqual(pod_annotations(changed, "discovery-service"), pod_annotations(baseline, "discovery-service"))

    def test_shared_rpc_url_change_updates_both_prover_payloads(self):
        baseline = pod_annotations(render(), "transaction-prover")
        changed = pod_annotations(render({"transactionProver": {"config": {"rpc_node_url": "http://other.synthetic.invalid"}}}), "transaction-prover")
        self.assertNotEqual(changed["checksum/config"], baseline["checksum/config"])
        self.assertNotEqual(changed["checksum/proof-interceptor-env"], baseline["checksum/proof-interceptor-env"])


class CredentialAndGuardTest(unittest.TestCase):
    def test_configmaps_exclude_ohttp_keys(self):
        prover_key, discovery_key = "SYNTHETIC-PROVER-OHTTP-KEY", "SYNTHETIC-DISCOVERY-OHTTP-KEY"
        resources = render({
            "transactionProver": {"ohttp": {"key": prover_key}},
            "discoveryService": {"ohttp": {"key": discovery_key}},
        })
        configmaps = [resource for (kind, _), resource in resources.items() if kind == "ConfigMap"]
        self.assertEqual(len(configmaps), 3)
        for configmap in configmaps:
            self.assertNotIn(prover_key, yaml.safe_dump(configmap))
            self.assertNotIn(discovery_key, yaml.safe_dump(configmap))
        self.assertIn({"name": "OHTTP_KEY", "value": prover_key}, container(resources, "transaction-prover", "transaction-prover")["env"])
        self.assertIn({"name": "OHTTP_KEY", "value": discovery_key}, container(resources, "discovery-service", "discovery-service")["env"])

    def test_required_guards_fail_with_their_messages(self):
        cases = {
            "transactionProver.proofInterceptor.screening.anonymizerAddress is required when proofInterceptor is enabled":
                {"transactionProver": {"proofInterceptor": {"screening": {"anonymizerAddress": ""}}}},
            "transactionProver.proofInterceptor.screening.rpcUrl is chart-owned":
                {"transactionProver": {"proofInterceptor": {"screening": {"rpcUrl": "http://other.synthetic.invalid"}}}},
            "discoveryService.config.rpcUrl is required":
                {"discoveryService": {"config": {"rpcUrl": ""}}},
            "discoveryService.config.wsUrl is required":
                {"discoveryService": {"config": {"wsUrl": ""}}},
        }
        for message, values in cases.items():
            with self.subTest(message=message):
                returncode, _, stderr = helm_template(values)
                self.assertNotEqual(returncode, 0)
                self.assertIn(message, stderr)

    def test_disabled_sidecar_does_not_require_its_settings(self):
        returncode, _, stderr = helm_template({"transactionProver": {"proofInterceptor": {
            "enabled": False, "screening": {"anonymizerAddress": "", "rpcUrl": "http://other.synthetic.invalid"}}}})
        self.assertEqual(returncode, 0, stderr)


if __name__ == "__main__":
    unittest.main()
