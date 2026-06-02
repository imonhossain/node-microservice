const { NxAppWebpackPlugin } = require('@nx/webpack/app-plugin');
const { join } = require('path');

/**
 * Bundle `@syncra/*` workspace siblings into main.js, externalise everything
 * else (Nest, drizzle, pg, etc.).
 *
 * Why: NxAppWebpackPlugin externalises every node_modules dep when
 * `target: 'node'`. At runtime, `@nx/js:node` then rewrites require() for those
 * externals — and for workspace libs it points at <repoRoot>/dist/libs/<name>,
 * a path that doesn't exist because our libs build into libs/<name>/dist.
 *
 * This plugin wraps the externals AFTER NxAppWebpackPlugin sets them, and
 * short-circuits `@syncra/*` to "bundle" (no externalisation).
 */
class BundleSyncraLibsPlugin {
  apply(compiler) {
    compiler.hooks.afterEnvironment.tap('BundleSyncraLibsPlugin', () => {
      const original = compiler.options.externals;
      const wrap = (entry) => {
        if (typeof entry !== 'function') return entry;
        return function (ctx, callback) {
          if (ctx.request && ctx.request.startsWith('@syncra/')) {
            return callback();
          }
          return entry(ctx, callback);
        };
      };
      compiler.options.externals = Array.isArray(original)
        ? original.map(wrap)
        : wrap(original);
    });
  }
}

module.exports = {
  output: {
    path: join(__dirname, 'dist'),
    clean: true,
    ...(process.env.NODE_ENV !== 'production' && {
      devtoolModuleFilenameTemplate: '[absolute-resource-path]',
    }),
  },
  plugins: [
    new NxAppWebpackPlugin({
      target: 'node',
      compiler: 'tsc',
      main: './src/main.ts',
      tsConfig: './tsconfig.app.json',
      assets: ['./src/assets'],
      optimization: false,
      outputHashing: 'none',
      generatePackageJson: false,
      sourceMap: true,
    }),
    new BundleSyncraLibsPlugin(),
  ],
};
