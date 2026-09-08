import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  CLAWEE_APP_SERVER_METHODS,
  acknowledgedCodexSchemaChanges,
  verifyCodexSchemaCompatibility
} from '../../scripts/codex-runtime/schema-compatibility.mjs';

const stableSchemaPath = new URL(
  '../../config/codex-app-server-schema/rust-v0.146.0/stable.json',
  import.meta.url
);
const experimentalSchemaPath = new URL(
  '../../config/codex-app-server-schema/rust-v0.146.0/experimental.json',
  import.meta.url
);
const candidateStableSchemaPath = new URL(
  '../../config/codex-app-server-schema/rust-v0.151.0/stable.json',
  import.meta.url
);
const candidateExperimentalSchemaPath = new URL(
  '../../config/codex-app-server-schema/rust-v0.151.0/experimental.json',
  import.meta.url
);

test('rejects_removed_thread_resume_and_required_optional_fields', () => {
  const baselineStable = readJson(stableSchemaPath);
  const candidateStable = structuredClone(baselineStable);
  const clientRequest = candidateStable.definitions.ClientRequest;
  clientRequest.oneOf = clientRequest.oneOf.filter(
    variant => variant.properties?.method?.enum?.[0] !== 'thread/resume'
  );
  candidateStable.definitions.v2.ConfigReadParams.required = [
    ...(candidateStable.definitions.v2.ConfigReadParams.required ?? []),
    'cwd'
  ];

  assert.throws(
    () => verifyCodexSchemaCompatibility({
      baseline: {
        stable: baselineStable,
        experimental: readJson(experimentalSchemaPath)
      },
      candidate: {
        stable: candidateStable,
        experimental: readJson(experimentalSchemaPath)
      }
    }),
    error => {
      assert.deepEqual(
        error.issues.map(issue => issue.code),
        ['METHOD_REMOVED', 'REQUEST_FIELD_BECAME_REQUIRED']
      );
      assert.match(error.message, /thread\/resume/);
      assert.match(error.message, /ConfigReadParams\.cwd/);
      return true;
    }
  );
});

test('allows_optional_additions_and_ignores_unused_usage_surface', () => {
  const stable = readJson(stableSchemaPath);
  const experimental = readJson(experimentalSchemaPath);
  const candidateStable = structuredClone(stable);
  candidateStable.definitions.v2.ConfigReadParams.properties.futureOptional = {
    type: ['string', 'null']
  };
  candidateStable.definitions.v2.Thread = {
    ...candidateStable.definitions.v2.Thread,
    properties: {
      ...candidateStable.definitions.v2.Thread.properties,
      threadUsage: { type: ['object', 'null'] }
    }
  };
  candidateStable.definitions.ClientRequest.oneOf.push({
    properties: {
      id: { $ref: '#/definitions/RequestId' },
      method: {
        enum: ['account/usage/read'],
        type: 'string'
      },
      params: { type: 'object' }
    },
    required: ['id', 'method', 'params'],
    type: 'object'
  });

  const result = verifyCodexSchemaCompatibility({
    baseline: { stable, experimental },
    candidate: {
      stable: candidateStable,
      experimental
    }
  });
  assert.equal(result.compatible, true);
  assert.equal(CLAWEE_APP_SERVER_METHODS.includes('account/usage/read'), false);
});

test('rejects_removed_discriminated_union_variants', () => {
  const stable = readJson(stableSchemaPath);
  const experimental = readJson(experimentalSchemaPath);
  const candidateStable = structuredClone(stable);
  const threadItem = candidateStable.definitions.v2.ThreadItem;
  const removedVariant = threadItem.oneOf[0];
  threadItem.oneOf = threadItem.oneOf.slice(1);

  assert.throws(
    () => verifyCodexSchemaCompatibility({
      baseline: { stable, experimental },
      candidate: {
        stable: candidateStable,
        experimental
      }
    }),
    error => {
      assert.equal(
        error.issues.some(
          issue => issue.code === 'DISCRIMINATED_UNION_VARIANT_REMOVED'
        ),
        true
      );
      assert.match(error.message, new RegExp(discriminatorValue(removedVariant)));
      return true;
    }
  );
});

test('accepts_only_the_reviewed_0_146_to_0_151_schema_delta', () => {
  const baseline = {
    stable: readJson(stableSchemaPath),
    experimental: readJson(experimentalSchemaPath)
  };
  const candidate = {
    stable: readJson(candidateStableSchemaPath),
    experimental: readJson(candidateExperimentalSchemaPath)
  };
  const acknowledgedIssues = acknowledgedCodexSchemaChanges(
    'rust-v0.146.0',
    'rust-v0.151.0'
  );

  assert.doesNotThrow(() => verifyCodexSchemaCompatibility({
    baseline,
    candidate,
    acknowledgedIssues
  }));

  const driftedStable = structuredClone(candidate.stable);
  delete driftedStable.definitions.v2.Thread.properties.preview;
  assert.throws(
    () => verifyCodexSchemaCompatibility({
      baseline,
      candidate: {
        stable: driftedStable,
        experimental: candidate.experimental
      },
      acknowledgedIssues
    }),
    error => {
      assert.equal(
        error.issues.some(
          issue => issue.code === 'FIELD_REMOVED'
            && issue.path.endsWith('.preview')
        ),
        true
      );
      return true;
    }
  );
});

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function discriminatorValue(variant) {
  for (const [field, property] of Object.entries(variant.properties ?? {})) {
    if (Array.isArray(property.enum) && property.enum.length === 1) {
      return `${field}=${JSON.stringify(property.enum[0])}`;
    }
  }
  throw new Error('Expected a discriminated ThreadItem variant');
}
