// Resolve hook for `node --test --experimental-strip-types` over the app
// sources: app modules import each other extensionless (bundler resolution),
// which Node ESM cannot resolve natively. Extensionless *relative* specifiers
// are retried with a `.ts` extension. Package specifiers are untouched.
export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context)
  } catch (error) {
    if (
      error &&
      error.code === 'ERR_MODULE_NOT_FOUND' &&
      /^\.{1,2}\//.test(specifier)
    ) {
      return nextResolve(`${specifier}.ts`, context)
    }
    throw error
  }
}
