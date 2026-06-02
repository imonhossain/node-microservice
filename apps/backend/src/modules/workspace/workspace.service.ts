import {
  Injectable,
  NotFoundException,
  GoneException,
} from '@nestjs/common';
// Always import drizzle helpers THROUGH db-kit. Importing from 'drizzle-orm'
// directly triggers the dual-package hazard (backend = CJS, db-kit = ESM →
// two distinct SQL<unknown> types). See plan/day3 + libs/db-kit/src/index.ts.
//
// `db`     = superuser connection, bypasses RLS. Use for cross-tenant
//            discovery queries (find-by-slug, list-by-user). The discovery
//            target is the workspace itself, so we can't set
//            app.workspace_id before the lookup.
// `appDb`  = app_user connection, RLS enforced. Use for all per-tenant
//            reads/writes inside withCtx(); set app.workspace_id first.
import { appDb, db, schema, and, eq, gt, isNull, sql } from '@syncra/db-kit';
import { randomUUID } from 'node:crypto';
import { MailService } from '../mail/mail.service';
import { generateRawToken, hashToken, verifyToken } from './invitation-token';

@Injectable()
export class WorkspaceService {
  constructor(private readonly mail: MailService) {}

  async isSlugAvailable(slug: string): Promise<boolean> {
    // Discovery query — must see across all tenants (RLS would hide existing
    // workspaces and falsely report "available", letting two users create
    // colliding slugs that only the unique index catches).
    const existing = await db.query.workspaces.findFirst({
      where: eq(schema.workspaces.slug, slug),
    });
    return !existing;
  }

  /**
   * Create workspace + owner membership atomically.
   * Sets app.workspace_id to the new id so the RLS WITH CHECK clause passes.
   */
  async create(args: { slug: string; name: string; ownerId: string }) {
    const newId = randomUUID();
    return appDb.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT set_config('app.workspace_id', ${newId}, true)`,
      );
      await tx.execute(
        sql`SELECT set_config('app.user_id',      ${args.ownerId}, true)`,
      );

      const [ws] = await tx
        .insert(schema.workspaces)
        .values({
          id: newId,
          slug: args.slug,
          name: args.name,
          ownerId: args.ownerId,
        })
        .returning();

      await tx.insert(schema.workspaceMembers).values({
        workspaceId: ws.id,
        userId: args.ownerId,
        role: 'owner',
      });

      return ws;
    });
  }

  async listForUser(userId: string) {
    // Cross-tenant by design: a user belongs to many workspaces. We trust
    // the userId filter (it comes from the verified session cookie) and
    // bypass RLS so the JOIN returns every membership.
    return db
      .select({
        id: schema.workspaces.id,
        slug: schema.workspaces.slug,
        name: schema.workspaces.name,
        role: schema.workspaceMembers.role,
      })
      .from(schema.workspaceMembers)
      .innerJoin(
        schema.workspaces,
        eq(schema.workspaces.id, schema.workspaceMembers.workspaceId),
      )
      .where(eq(schema.workspaceMembers.userId, userId));
  }

  async findBySlug(slug: string) {
    // Discovery query — the very thing we'd need to know to set
    // app.workspace_id IS what we're trying to find. Bypass RLS for the
    // lookup; membership is asserted separately by WorkspaceMiddleware.
    return db.query.workspaces.findFirst({
      where: eq(schema.workspaces.slug, slug),
    });
  }

  async getMembership(workspaceId: string, userId: string) {
    return appDb.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT set_config('app.workspace_id', ${workspaceId}, true)`,
      );
      await tx.execute(
        sql`SELECT set_config('app.user_id',      ${userId}, true)`,
      );
      return tx.query.workspaceMembers.findFirst({
        where: and(
          eq(schema.workspaceMembers.workspaceId, workspaceId),
          eq(schema.workspaceMembers.userId, userId),
        ),
      });
    });
  }

  async listMembers(workspaceId: string, userId: string) {
    return appDb.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT set_config('app.workspace_id', ${workspaceId}, true)`,
      );
      await tx.execute(
        sql`SELECT set_config('app.user_id',      ${userId}, true)`,
      );
      return tx
        .select({
          userId: schema.workspaceMembers.userId,
          role: schema.workspaceMembers.role,
          joinedAt: schema.workspaceMembers.joinedAt,
          email: schema.users.email,
          displayName: schema.users.displayName,
          avatarUrl: schema.users.avatarUrl,
        })
        .from(schema.workspaceMembers)
        .innerJoin(
          schema.users,
          eq(schema.users.id, schema.workspaceMembers.userId),
        )
        .where(eq(schema.workspaceMembers.workspaceId, workspaceId));
    });
  }

  async invite(args: {
    workspaceId: string;
    workspaceName: string;
    invitedBy: { id: string; displayName: string | null; email: string };
    email: string;
    role: 'admin' | 'member' | 'viewer';
  }): Promise<{ acceptUrl: string }> {
    const raw = generateRawToken();
    const tokenHash = await hashToken(raw);
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    await appDb.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT set_config('app.workspace_id', ${args.workspaceId}, true)`,
      );
      await tx.execute(
        sql`SELECT set_config('app.user_id',      ${args.invitedBy.id}, true)`,
      );
      await tx.insert(schema.invitations).values({
        workspaceId: args.workspaceId,
        email: args.email,
        role: args.role,
        tokenHash,
        invitedBy: args.invitedBy.id,
        expiresAt,
      });
    });

    const acceptUrl = `${process.env.APP_ORIGIN}/invite/${raw}`;
    await this.mail.sendInvite({
      to: args.email,
      inviter: args.invitedBy.displayName ?? args.invitedBy.email,
      workspaceName: args.workspaceName,
      acceptUrl,
    });

    return { acceptUrl };
  }

  /**
   * Accept an invitation by raw token. We scan non-accepted, non-expired
   * invitations and argon2.verify each — fine at our scale.
   */
  async accept(args: {
    rawToken: string;
    userId: string;
  }): Promise<{ workspaceSlug: string }> {
    const candidates = await appDb
      .select()
      .from(schema.invitations)
      .where(
        and(
          isNull(schema.invitations.acceptedAt),
          gt(schema.invitations.expiresAt, new Date()),
        ),
      );

    let matched: (typeof candidates)[number] | null = null;
    for (const c of candidates) {
      if (await verifyToken(c.tokenHash, args.rawToken)) {
        matched = c;
        break;
      }
    }
    if (!matched)
      throw new NotFoundException('Invitation not found or expired');

    return appDb.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT set_config('app.workspace_id', ${matched.workspaceId}, true)`,
      );
      await tx.execute(
        sql`SELECT set_config('app.user_id',      ${args.userId}, true)`,
      );

      // Check user isn't already a member (idempotent re-accept).
      const existing = await tx.query.workspaceMembers.findFirst({
        where: and(
          eq(schema.workspaceMembers.workspaceId, matched.workspaceId),
          eq(schema.workspaceMembers.userId, args.userId),
        ),
      });
      if (!existing) {
        await tx.insert(schema.workspaceMembers).values({
          workspaceId: matched.workspaceId,
          userId: args.userId,
          role: matched.role,
        });
      }

      await tx
        .update(schema.invitations)
        .set({ acceptedAt: new Date() })
        .where(eq(schema.invitations.id, matched.id));

      const ws = await tx.query.workspaces.findFirst({
        where: eq(schema.workspaces.id, matched.workspaceId),
      });
      if (!ws) throw new GoneException('Workspace was deleted');
      return { workspaceSlug: ws.slug };
    });
  }
}
