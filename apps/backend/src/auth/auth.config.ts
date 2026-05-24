import GitHub from '@auth/express/providers/github';
import type { ExpressAuthConfig } from '@auth/express';

export const authConfig: ExpressAuthConfig = {
  debug: true,
  trustHost: true,
  secret: process.env.AUTH_SECRET,

  providers: [
    GitHub({
      clientId: process.env.AUTH_GITHUB_ID!,
      clientSecret: process.env.AUTH_GITHUB_SECRET!,
    }),
  ],

  session: {
    strategy: 'jwt',
    maxAge: 60 * 60 * 24 * 7,            // 7 days
  },

  // In dev (http://localhost) we let Auth.js choose cookie names + flags.
  // It will use `authjs.session-token` over plain HTTP and auto-prefix
  // `__Secure-` / `__Host-` once you serve over HTTPS in production.
  // Day 41 (prod HTTPS) is when we tighten the cookie name back to
  // `__Host-syncra-session` with explicit `secure: true`.

  callbacks: {
    // Put what we need into the JWT payload.
    async jwt({ token, account, profile }) {
      if (account && profile) {
        // First sign-in: store the IdP details on the token.
        token.sub = String(profile.id ?? token.sub);
        token.email = profile.email ?? token.email;
        token.name = profile.name ?? token.name;
        token.picture = (profile as { avatar_url?: string }).avatar_url ?? token.picture;
        token.provider = account.provider;
      }
      return token;
    },

    // Shape the session object Auth.js exposes.
    async session({ session, token }) {
      if (token.sub) session.user = { ...session.user, id: token.sub };
      return session;
    },
  },

  pages: {
    signIn: '/login',
  },
};