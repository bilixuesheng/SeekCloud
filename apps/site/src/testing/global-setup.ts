import { createTemplateDatabase, dropTemplateDatabase } from "./database";

export const setup = createTemplateDatabase;
export const teardown = dropTemplateDatabase;
