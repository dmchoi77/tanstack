export const REMOTE_STYLESHEET_RESOLVER_MODULE =
  "@module-federation/tanstack/remote-stylesheet-resolver";

export const RESOLVED_REMOTE_STYLESHEET_RESOLVER_MODULE = `\0${REMOTE_STYLESHEET_RESOLVER_MODULE}`;

/**
 * Generates the adapter-owned resolver module. The remote configuration is serialized at
 * build time so server and browser bundles use the same manifest identity policy without a
 * process-global federation runtime singleton.
 */
export function createRemoteStylesheetResolverModule(remotes: unknown): string {
  const serializedRemotes = JSON.stringify(remotes ?? {});
  if (serializedRemotes === undefined) {
    throw new TypeError("Remote stylesheet remotes must be JSON serializable.");
  }

  return `import { createRemoteStylesheetResolver } from "@module-federation/tanstack/runtime";

export const resolveRemoteStylesheet = createRemoteStylesheetResolver(${serializedRemotes});
export default resolveRemoteStylesheet;
`;
}
