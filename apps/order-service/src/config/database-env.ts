import { z } from 'zod';

export const databaseEnvSchema = z.object({
  ORDER_DB_HOST: z.string().min(1),
  ORDER_DB_PORT: z.coerce.number().int().min(1).max(65535),
  ORDER_DB_NAME: z.string().min(1),
  ORDER_DB_USER: z.string().min(1),
  ORDER_DB_PASSWORD: z.string().min(1),
});

export function validateDatabaseEnv(config: Record<string, unknown>) {
  const result = databaseEnvSchema.safeParse(config);

  if (!result.success) {
    const errors = result.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');

    throw new Error(`Invalid database configuration: ${errors}`);
  }

  return { ...config, ...result.data };
}