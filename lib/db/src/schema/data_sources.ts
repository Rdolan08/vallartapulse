import { pgTable, serial, text, boolean, integer, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const dataSourcesTable = pgTable("data_sources", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  nameEs: text("name_es"),
  category: text("category").notNull(),
  description: text("description"),
  descriptionEs: text("description_es"),
  url: text("url"),
  status: text("status").notNull().default("active"),
  lastSyncedAt: timestamp("last_synced_at"),
  recordCount: integer("record_count"),
  frequency: text("frequency").notNull().default("monthly"),
  isPublic: boolean("is_public").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertDataSourceSchema = createInsertSchema(dataSourcesTable).omit({ id: true, createdAt: true });
export type InsertDataSource = z.infer<typeof insertDataSourceSchema>;
export type DataSource = typeof dataSourcesTable.$inferSelect;
