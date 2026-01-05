export default {
  extends: ["@commitlint/config-conventional"],
  rules: {
    "type-enum": [
      2,
      "always",
      [
        "feat", // New feature
        "fix", // Bug fix
        "docs", // Documentation
        "style", // Formatting (no code change)
        "refactor", // Code change that neither fixes nor adds
        "perf", // Performance improvement
        "test", // Adding/updating tests
        "chore", // Maintenance tasks
        "ci", // CI/CD changes
        "revert", // Revert a commit
      ],
    ],
    "subject-case": [2, "always", "lower-case"],
  },
};
