import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { readCodexRuntimeManifest } from './manifest.mjs';

const PROJECT_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const ISSUE_PRIORITY = new Map([
  ['METHOD_REMOVED', 0],
  ['REQUEST_FIELD_BECAME_REQUIRED', 1]
]);
const RELEASE_SCHEMA_ACKNOWLEDGEMENTS = new Map([
  [
    'rust-v0.146.0->rust-v0.151.0',
    [
      acknowledged(
        'DISCRIMINATED_UNION_VARIANT_ADDED',
        'config/read.response.layers[].name.type="packagedDefaults"'
      ),
      acknowledged(
        'FIELD_REMOVED',
        'thread/read.response.thread.isPinned'
      ),
      acknowledged(
        'DISCRIMINATED_UNION_VARIANT_ADDED',
        'thread/read.response.thread.turns[].items[].type="functionCallOutput"'
      ),
      acknowledged(
        'ENUM_CHANGED',
        'thread/read.response.thread.turns[].items[].type="subAgentActivity".kind'
      ),
      acknowledged(
        'FIELD_REMOVED',
        'thread/resume.response.thread.isPinned'
      ),
      acknowledged(
        'DISCRIMINATED_UNION_VARIANT_ADDED',
        'thread/resume.response.thread.turns[].items[].type="functionCallOutput"'
      ),
      acknowledged(
        'ENUM_CHANGED',
        'thread/resume.response.thread.turns[].items[].type="subAgentActivity".kind'
      ),
      acknowledged(
        'UNION_VARIANT_CHANGED',
        'thread/search.params.sortKey'
      ),
      acknowledged(
        'FIELD_REMOVED',
        'thread/search.response.data[].thread.isPinned'
      ),
      acknowledged(
        'DISCRIMINATED_UNION_VARIANT_ADDED',
        'thread/search.response.data[].thread.turns[].items[].type="functionCallOutput"'
      ),
      acknowledged(
        'ENUM_CHANGED',
        'thread/search.response.data[].thread.turns[].items[].type="subAgentActivity".kind'
      ),
      acknowledged(
        'FIELD_REMOVED',
        'thread/start.response.thread.isPinned'
      ),
      acknowledged(
        'DISCRIMINATED_UNION_VARIANT_ADDED',
        'thread/start.response.thread.turns[].items[].type="functionCallOutput"'
      ),
      acknowledged(
        'ENUM_CHANGED',
        'thread/start.response.thread.turns[].items[].type="subAgentActivity".kind'
      ),
      acknowledged(
        'DISCRIMINATED_UNION_VARIANT_ADDED',
        'thread/turns/list.response.data[].items[].type="functionCallOutput"'
      ),
      acknowledged(
        'ENUM_CHANGED',
        'thread/turns/list.response.data[].items[].type="subAgentActivity".kind'
      ),
      acknowledged(
        'DISCRIMINATED_UNION_VARIANT_ADDED',
        'turn/start.response.turn.items[].type="functionCallOutput"'
      ),
      acknowledged(
        'ENUM_CHANGED',
        'turn/start.response.turn.items[].type="subAgentActivity".kind'
      )
    ]
  ]
]);

const CLIENT_METHOD_CONTRACTS = [
  contract('stable', 'thread/resume', 'ThreadResumeParams', 'ThreadResumeResponse'),
  contract('stable', 'config/read', 'ConfigReadParams', 'ConfigReadResponse'),
  contract('stable', 'initialize', 'InitializeParams', 'InitializeResponse', 'root'),
  contract('stable', 'config/batchWrite', 'ConfigBatchWriteParams', 'ConfigWriteResponse'),
  contract('stable', 'thread/start', 'ThreadStartParams', 'ThreadStartResponse'),
  contract('stable', 'thread/read', 'ThreadReadParams', 'ThreadReadResponse'),
  contract(
    'experimental',
    'thread/turns/list',
    'ThreadTurnsListParams',
    'ThreadTurnsListResponse'
  ),
  contract(
    'experimental',
    'thread/search',
    'ThreadSearchParams',
    'ThreadSearchResponse'
  ),
  contract('stable', 'turn/start', 'TurnStartParams', 'TurnStartResponse'),
  contract('stable', 'turn/interrupt', 'TurnInterruptParams', 'TurnInterruptResponse'),
  contract(
    'stable',
    'config/mcpServer/reload',
    undefined,
    'McpServerRefreshResponse'
  ),
  contract('stable', 'model/list', 'ModelListParams', 'ModelListResponse')
];

const SERVER_METHOD_CONTRACTS = [
  serverContract(
    'item/commandExecution/requestApproval',
    'CommandExecutionRequestApprovalParams',
    'CommandExecutionRequestApprovalResponse'
  ),
  serverContract(
    'item/fileChange/requestApproval',
    'FileChangeRequestApprovalParams',
    'FileChangeRequestApprovalResponse'
  ),
  serverContract(
    'item/permissions/requestApproval',
    'PermissionsRequestApprovalParams',
    'PermissionsRequestApprovalResponse'
  ),
  serverContract(
    'mcpServer/elicitation/request',
    'McpServerElicitationRequestParams',
    'McpServerElicitationRequestResponse'
  )
];

export const CLAWEE_APP_SERVER_METHODS = Object.freeze([
  ...CLIENT_METHOD_CONTRACTS.map(item => item.method),
  ...SERVER_METHOD_CONTRACTS.map(item => item.method)
]);

export class CodexSchemaCompatibilityError extends Error {
  constructor(issues) {
    super(`Codex app-server Schema is incompatible:\n${issues
      .map(issue => `- [${issue.code}] ${issue.path}: ${issue.message}`)
      .join('\n')}`);
    this.name = 'CodexSchemaCompatibilityError';
    this.code = 'CODEX_SCHEMA_INCOMPATIBLE';
    this.issues = issues;
  }
}

export function acknowledgedCodexSchemaChanges(
  previousReleaseTag,
  releaseTag
) {
  return (
    RELEASE_SCHEMA_ACKNOWLEDGEMENTS.get(
      `${previousReleaseTag}->${releaseTag}`
    ) ?? []
  ).map(issue => ({ ...issue }));
}

export function verifyCodexSchemaCompatibility(input) {
  const issues = [];
  for (const item of CLIENT_METHOD_CONTRACTS) {
    compareMethodContract(
      input.baseline[item.channel],
      input.candidate[item.channel],
      'ClientRequest',
      item,
      issues
    );
  }
  for (const item of SERVER_METHOD_CONTRACTS) {
    compareMethodContract(
      input.baseline.stable,
      input.candidate.stable,
      'ServerRequest',
      item,
      issues
    );
  }
  const observed = new Set(issues.map(issueKey));
  const acknowledgedIssues = input.acknowledgedIssues ?? [];
  const acknowledgedKeys = new Set(acknowledgedIssues.map(issueKey));
  const failures = issues.filter(issue => !acknowledgedKeys.has(issueKey(issue)));
  for (const issue of acknowledgedIssues) {
    if (observed.has(issueKey(issue))) continue;
    failures.push(schemaIssue(
      'ACKNOWLEDGED_SCHEMA_CHANGE_MISSING',
      issue.path,
      `Acknowledged ${issue.code} change was not observed`
    ));
  }
  failures.sort(compareIssues);
  if (failures.length > 0) {
    throw new CodexSchemaCompatibilityError(failures);
  }
  return {
    compatible: true,
    methods: [...CLAWEE_APP_SERVER_METHODS]
  };
}

function compareMethodContract(
  baselineSchema,
  candidateSchema,
  unionName,
  item,
  issues
) {
  const baselineVariant = findMethodVariant(
    baselineSchema,
    unionName,
    item.method
  );
  if (baselineVariant === undefined) {
    issues.push(schemaIssue(
      'BASELINE_METHOD_MISSING',
      item.method,
      `Baseline ${item.channel} Schema does not expose ${item.method}`
    ));
    return;
  }
  const candidateVariant = findMethodVariant(
    candidateSchema,
    unionName,
    item.method
  );
  if (candidateVariant === undefined) {
    issues.push(schemaIssue(
      'METHOD_REMOVED',
      item.method,
      `${item.method} was removed from ${item.channel} ${unionName}`
    ));
    return;
  }

  compareSchemaNode({
    baselineRoot: baselineSchema,
    candidateRoot: candidateSchema,
    baselineNode: baselineVariant.properties?.params,
    candidateNode: candidateVariant.properties?.params,
    path: `${item.method}.params`,
    direction: 'request',
    issues,
    visited: new Set()
  });

  const baselineResponse = definition(
    baselineSchema,
    item.response,
    item.namespace
  );
  const candidateResponse = definition(
    candidateSchema,
    item.response,
    item.namespace
  );
  if (baselineResponse === undefined) {
    issues.push(schemaIssue(
      'BASELINE_RESPONSE_SCHEMA_MISSING',
      `${item.method}.response`,
      `Baseline response Schema ${item.response} is missing`
    ));
    return;
  }
  if (candidateResponse === undefined) {
    issues.push(schemaIssue(
      'RESPONSE_SCHEMA_REMOVED',
      `${item.method}.response`,
      `Response Schema ${item.response} was removed`
    ));
    return;
  }
  compareSchemaNode({
    baselineRoot: baselineSchema,
    candidateRoot: candidateSchema,
    baselineNode: baselineResponse,
    candidateNode: candidateResponse,
    path: `${item.method}.response`,
    direction: 'response',
    issues,
    visited: new Set()
  });
}

function compareSchemaNode(context) {
  const baselineNode = resolveNode(
    context.baselineRoot,
    context.baselineNode
  );
  const candidateNode = resolveNode(
    context.candidateRoot,
    context.candidateNode
  );
  if (baselineNode === undefined && candidateNode === undefined) return;
  if (baselineNode === undefined || candidateNode === undefined) {
    context.issues.push(schemaIssue(
      'SCHEMA_NODE_REMOVED',
      context.path,
      'A required Schema node was removed'
    ));
    return;
  }

  const visitKey = `${nodeIdentity(context.baselineNode)}=>${nodeIdentity(context.candidateNode)}:${context.direction}`;
  if (context.visited.has(visitKey)) return;
  context.visited.add(visitKey);

  compareScalarKeyword('type', baselineNode, candidateNode, context);
  compareScalarKeyword('format', baselineNode, candidateNode, context);
  compareEnum(baselineNode, candidateNode, context);
  compareRequired(baselineNode, candidateNode, context);
  compareProperties(baselineNode, candidateNode, context);
  compareUnion('oneOf', baselineNode, candidateNode, context);
  compareUnion('anyOf', baselineNode, candidateNode, context);

  if (baselineNode.items !== undefined) {
    compareSchemaNode({
      ...context,
      baselineNode: baselineNode.items,
      candidateNode: candidateNode.items,
      path: `${context.path}[]`
    });
  }
  if (
    typeof baselineNode.additionalProperties === 'object'
    && baselineNode.additionalProperties !== null
  ) {
    compareSchemaNode({
      ...context,
      baselineNode: baselineNode.additionalProperties,
      candidateNode: candidateNode.additionalProperties,
      path: `${context.path}.*`
    });
  }
}

function compareRequired(baselineNode, candidateNode, context) {
  const baselineRequired = new Set(baselineNode.required ?? []);
  const candidateRequired = new Set(candidateNode.required ?? []);
  if (context.direction === 'request') {
    for (const field of candidateRequired) {
      if (!baselineRequired.has(field)) {
        context.issues.push(schemaIssue(
          'REQUEST_FIELD_BECAME_REQUIRED',
          `${definitionName(context.baselineNode)}.${field}`,
          `${field} became required`
        ));
      }
    }
    return;
  }
  for (const field of baselineRequired) {
    if (!candidateRequired.has(field)) {
      context.issues.push(schemaIssue(
        'RESPONSE_FIELD_BECAME_OPTIONAL',
        `${context.path}.${field}`,
        `${field} is no longer guaranteed in the response`
      ));
    }
  }
}

function compareProperties(baselineNode, candidateNode, context) {
  const baselineProperties = baselineNode.properties ?? {};
  const candidateProperties = candidateNode.properties ?? {};
  for (const [field, baselineProperty] of Object.entries(baselineProperties)) {
    const candidateProperty = candidateProperties[field];
    if (candidateProperty === undefined) {
      context.issues.push(schemaIssue(
        'FIELD_REMOVED',
        `${context.path}.${field}`,
        `${field} was removed`
      ));
      continue;
    }
    compareSchemaNode({
      ...context,
      baselineNode: baselineProperty,
      candidateNode: candidateProperty,
      path: `${context.path}.${field}`
    });
  }
}

function compareUnion(keyword, baselineNode, candidateNode, context) {
  const baselineVariants = baselineNode[keyword];
  if (!Array.isArray(baselineVariants)) return;
  const candidateVariants = candidateNode[keyword];
  if (!Array.isArray(candidateVariants)) {
    context.issues.push(schemaIssue(
      'DISCRIMINATED_UNION_REMOVED',
      context.path,
      `${keyword} was removed`
    ));
    return;
  }

  const baselineByDiscriminator = discriminatorMap(baselineVariants);
  const candidateByDiscriminator = discriminatorMap(candidateVariants);
  if (
    baselineByDiscriminator !== undefined
    && candidateByDiscriminator !== undefined
  ) {
    for (const [key, baselineVariant] of baselineByDiscriminator) {
      const candidateVariant = candidateByDiscriminator.get(key);
      if (candidateVariant === undefined) {
        context.issues.push(schemaIssue(
          'DISCRIMINATED_UNION_VARIANT_REMOVED',
          `${context.path}.${key}`,
          `Discriminated union variant ${key} was removed`
        ));
        continue;
      }
      compareSchemaNode({
        ...context,
        baselineNode: baselineVariant,
        candidateNode: candidateVariant,
        path: `${context.path}.${key}`
      });
    }
    if (context.direction === 'response') {
      for (const key of candidateByDiscriminator.keys()) {
        if (!baselineByDiscriminator.has(key)) {
          context.issues.push(schemaIssue(
            'DISCRIMINATED_UNION_VARIANT_ADDED',
            `${context.path}.${key}`,
            `Response discriminated union added variant ${key}`
          ));
        }
      }
    }
    return;
  }

  const baselineCanonical = new Set(baselineVariants.map(canonicalJson));
  const candidateCanonical = new Set(candidateVariants.map(canonicalJson));
  for (const variant of baselineCanonical) {
    if (!candidateCanonical.has(variant)) {
      context.issues.push(schemaIssue(
        'UNION_VARIANT_CHANGED',
        context.path,
        `${keyword} changed incompatibly`
      ));
      break;
    }
  }
}

function compareScalarKeyword(keyword, baselineNode, candidateNode, context) {
  if (baselineNode[keyword] === undefined) return;
  if (
    canonicalJson(baselineNode[keyword])
    !== canonicalJson(candidateNode[keyword])
  ) {
    context.issues.push(schemaIssue(
      'FIELD_TYPE_CHANGED',
      context.path,
      `${keyword} changed incompatibly`
    ));
  }
}

function compareEnum(baselineNode, candidateNode, context) {
  if (!Array.isArray(baselineNode.enum)) return;
  if (
    !Array.isArray(candidateNode.enum)
    || canonicalJson([...baselineNode.enum].sort())
      !== canonicalJson([...candidateNode.enum].sort())
  ) {
    context.issues.push(schemaIssue(
      'ENUM_CHANGED',
      context.path,
      'enum values changed incompatibly'
    ));
  }
}

function findMethodVariant(schema, unionName, method) {
  const variants = schema?.definitions?.[unionName]?.oneOf;
  if (!Array.isArray(variants)) return undefined;
  return variants.find(
    variant => variant.properties?.method?.enum?.[0] === method
  );
}

function definition(schema, name, namespace = 'v2') {
  if (name === undefined) return {};
  return namespace === 'root'
    ? schema?.definitions?.[name]
    : schema?.definitions?.[namespace]?.[name];
}

function resolveNode(root, node) {
  if (node === undefined) return undefined;
  const reference = node.$ref;
  if (typeof reference !== 'string') return node;
  if (!reference.startsWith('#/')) return undefined;
  return reference
    .slice(2)
    .split('/')
    .map(part => part.replaceAll('~1', '/').replaceAll('~0', '~'))
    .reduce((value, part) => value?.[part], root);
}

function discriminatorMap(variants) {
  const result = new Map();
  for (const variant of variants) {
    const key = discriminatorKey(variant);
    if (key === undefined || result.has(key)) return undefined;
    result.set(key, variant);
  }
  return result;
}

function discriminatorKey(variant) {
  if (typeof variant.$ref === 'string') return `ref:${definitionName(variant)}`;
  for (const [field, property] of Object.entries(variant.properties ?? {})) {
    const value = property.const ?? (
      Array.isArray(property.enum) && property.enum.length === 1
        ? property.enum[0]
        : undefined
    );
    if (value !== undefined) return `${field}=${JSON.stringify(value)}`;
  }
  return undefined;
}

function definitionName(node) {
  if (typeof node?.$ref !== 'string') return 'schema';
  return node.$ref.split('/').at(-1) ?? 'schema';
}

function nodeIdentity(node) {
  if (typeof node?.$ref === 'string') return node.$ref;
  return canonicalJson(node);
}

function canonicalJson(value) {
  if (Array.isArray(value)) return JSON.stringify(value.map(canonicalValue));
  return JSON.stringify(canonicalValue(value));
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map(key => [key, canonicalValue(value[key])])
  );
}

function contract(channel, method, params, response, namespace = 'v2') {
  return { channel, method, params, response, namespace };
}

function serverContract(method, params, response) {
  return {
    channel: 'stable',
    method,
    params,
    response,
    namespace: 'root'
  };
}

function schemaIssue(code, path, message) {
  return { code, path, message };
}

function acknowledged(code, path) {
  return { code, path };
}

function issueKey(issue) {
  return `${issue.code}\u0000${issue.path}`;
}

function compareIssues(left, right) {
  const leftPriority = ISSUE_PRIORITY.get(left.code) ?? 100;
  const rightPriority = ISSUE_PRIORITY.get(right.code) ?? 100;
  return leftPriority - rightPriority
    || left.path.localeCompare(right.path)
    || left.code.localeCompare(right.code);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function loadSchemas(manifest) {
  const candidateStablePath = resolve(PROJECT_ROOT, manifest.schemas.stable.path);
  const candidateExperimentalPath = resolve(
    PROJECT_ROOT,
    manifest.schemas.experimental.path
  );
  const baselineRoot = resolve(
    dirname(candidateStablePath),
    '..',
    manifest.previousSupportedReleaseTag
  );
  return {
    baseline: {
      stable: readJson(resolve(baselineRoot, 'stable.json')),
      experimental: readJson(resolve(baselineRoot, 'experimental.json'))
    },
    candidate: {
      stable: readJson(candidateStablePath),
      experimental: readJson(candidateExperimentalPath)
    },
    acknowledgedIssues: acknowledgedCodexSchemaChanges(
      manifest.previousSupportedReleaseTag,
      manifest.releaseTag
    )
  };
}

if (process.argv[1] !== undefined) {
  const invokedUrl = pathToFileURL(resolve(process.argv[1])).href;
  if (import.meta.url === invokedUrl) {
    const manifest = readCodexRuntimeManifest();
    verifyCodexSchemaCompatibility(loadSchemas(manifest));
  }
}
