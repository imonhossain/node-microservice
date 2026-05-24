import { Injectable } from '@nestjs/common';
import { db, schema, eq } from '@syncra/db-kit';

export type IdpProfile = {
  externalId: string;
  email: string;
  displayName: string | null;
  avatarUrl: string | null;
};

@Injectable()
export class IdentityService {
  /**
   * JIT (just-in-time) user lookup.
   * Returns the existing users row, or creates one on first sign-in.
   */
  async getOrCreateUser(profile: IdpProfile) {
    const existing = await db.query.users.findFirst({
      where: eq(schema.users.externalId, profile.externalId),
    });
    if (existing) return existing;

    const [created] = await db
      .insert(schema.users)
      .values({
        externalId: profile.externalId,
        email: profile.email,
        displayName: profile.displayName,
        avatarUrl: profile.avatarUrl,
      })
      .returning();

    // Day 4 will publish `user.registered` here via the outbox pattern.
    return created;
  }
}