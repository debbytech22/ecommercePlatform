import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { getNotificationDatabaseOptions } from './database-options';

@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      useFactory: () => getNotificationDatabaseOptions(process.env),
    }),
  ],
})
export class DatabaseModule {}
