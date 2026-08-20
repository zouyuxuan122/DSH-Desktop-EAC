// TDD regression test: verify that a persona row mounted under an agent scope
// lands in the SCOPED layer (shadowing the global deployment:persona) rather
// than colliding with the global registration.
//
// This reproduces the bug where mounting the "standard" agent preset fails
// with `prompt section "deployment:persona" is already registered`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import * as persona from '@deepseek-ai/dsh-persona';
import { createScope, scopeOf } from '@deepseek-ai/dsh-scope';

test('persona row mounted in a scope shadows the global deployment persona', async () => {
  const ctx = new Context();
  await ctx.plugin(SystemPrompt, { includeHarnessIdentity: false, persona: 'deployment persona' });

  // Simulate what dsh-agent-presets does: mint a standing scope, then mount
  // the persona row (a plugin with inject: ["systemPrompt"]) inside it.
  const agentKey = { agent: 'standard' };
  const scope = createScope(ctx, agentKey);
  const { ctx: scoped } = scope;
  assert.notEqual(scopeOf(scoped), undefined, 'scoped ctx must carry a scope key');

  await scoped.plugin(persona, { text: 'per-agent persona' });

  // Assembling for that scope must see the per-agent persona shadowing the
  // global one.
  const assembly = await ctx.systemPrompt.assemble({ scope: scopeOf(scoped) });
  const personaSection = assembly.sections.find((s) => s.name === 'deployment:persona');
  assert.equal(personaSection.text, 'per-agent persona', 'scoped persona must shadow the global deployment persona');

  await scope.dispose();
});

test('global assembly still sees the deployment persona', async () => {
  const ctx = new Context();
  await ctx.plugin(SystemPrompt, { includeHarnessIdentity: false, persona: 'deployment persona' });

  const assembly = await ctx.systemPrompt.assemble({});
  const personaSection = assembly.sections.find((s) => s.name === 'deployment:persona');
  assert.equal(personaSection.text, 'deployment persona');
});
