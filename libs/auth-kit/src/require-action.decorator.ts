import { SetMetadata } from '@nestjs/common';
export const REQUIRE_ACTION_KEY = 'syncra:requireAction';
export const RequireAction = (action: string) => SetMetadata(REQUIRE_ACTION_KEY, action);