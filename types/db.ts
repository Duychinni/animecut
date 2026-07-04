export type Json = string | number | boolean | null | { [key: string]: Json } | Json[];

type GenericRow = Record<string, unknown>;

export type Database = {
  public: {
    Tables: {
      projects: { Row: GenericRow; Insert: GenericRow; Update: GenericRow };
      transcripts: { Row: GenericRow; Insert: GenericRow; Update: GenericRow };
      clip_candidates: { Row: GenericRow; Insert: GenericRow; Update: GenericRow };
      exports: { Row: GenericRow; Insert: GenericRow; Update: GenericRow };
      jobs: { Row: GenericRow; Insert: GenericRow; Update: GenericRow };
    };
  };
};
