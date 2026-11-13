# Platform release

## Workflow validation

- Validate GitHub Actions workflows with the existing workflow linters and normal workflow execution.
- Do not add or retain separate tests for workflow YAML, including structural assertions or extracted embedded steps.
- Validate small CI and deployment helper scripts through the workflows that invoke them, rather than separate unit, integration, or contract tests. Keep application and standalone release-engine tests focused on their own behavior.
