/**
 * TDAI Core — Host-neutral type definitions and abstract interfaces.
 *
 * These types define the boundary between TDAI Core (memory algorithms)
 * and the host environment (OpenClaw, Hermes, standalone Gateway, etc.).
 *
 * Design principles:
 * 1. TDAI Core depends ONLY on these interfaces — never on a specific host.
 * 2. Each host provides its own implementation of HostAdapter + LLMRunnerFactory.
 * 3. RuntimeContext is the single source of truth for session/user identity.
 */
export {};
