#!/usr/bin/env python3
"""One-off DDL: creates the NPS survey platform's tables in MySQL PEP_CLS.

This is a separate, independent system from the existing PEP_CLS.nps_delivery /
nps_product tables (those are populated by an external pipeline this repo doesn't own
and only feed existing reporting - see scripts/nps_source.py). Nothing here reads from
or writes to those tables.

Five tables, one per stage of the flow:
  nps_survey          - a survey definition (name, active/archived)
  nps_question        - ordered questions on a survey (score/csat/choice/text), each optionally
                        shown only when earlier answers satisfy its conditions_json rule set
  nps_recipient       - one row per customer a survey link was generated for; tracks
                        send/response status regardless of channel or trigger source
  nps_response        - one row per submitted response (unique per recipient - a
                        recipient can only respond once, enforced by the UNIQUE key)
  nps_response_answer - one row per answered question within a response

Dry-run by default (prints the DDL); --apply creates the tables. Idempotent - CREATE
TABLE IF NOT EXISTS per table, safe to re-run.
"""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from mysql_lib import get_credential

SCHEMA = "PEP_CLS"

TABLES = [
    ("nps_survey", """
CREATE TABLE IF NOT EXISTS `nps_survey` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `name` VARCHAR(255) NOT NULL,
  `status` ENUM('active', 'archived') NOT NULL DEFAULT 'active',
  `created_by` VARCHAR(255) NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
""".strip()),
    ("nps_question", """
CREATE TABLE IF NOT EXISTS `nps_question` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `survey_id` BIGINT UNSIGNED NOT NULL,
  `position` INT UNSIGNED NOT NULL,
  `type` ENUM('score', 'csat', 'choice', 'text') NOT NULL,
  `question_text` TEXT NOT NULL,
  `options_json` TEXT NULL,
  `required` TINYINT(1) NOT NULL DEFAULT 1,
  `conditions_json` TEXT NULL,
  `condition_logic` ENUM('AND', 'OR') NOT NULL DEFAULT 'AND',
  PRIMARY KEY (`id`),
  KEY `survey_id_key` (`survey_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
""".strip()),
    ("nps_recipient", """
CREATE TABLE IF NOT EXISTS `nps_recipient` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `survey_id` BIGINT UNSIGNED NOT NULL,
  `name` VARCHAR(255) NULL,
  `phone` VARCHAR(32) NULL,
  `email` VARCHAR(255) NULL,
  `trigger_source` ENUM('manual', 'shiprocket', 'preview') NOT NULL DEFAULT 'manual',
  `order_ref` VARCHAR(64) NULL,
  `status` ENUM('pending', 'sent', 'responded', 'failed') NOT NULL DEFAULT 'pending',
  `sent_at` DATETIME NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `survey_id_key` (`survey_id`),
  KEY `survey_order_key` (`survey_id`, `order_ref`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
""".strip()),
    ("nps_response", """
CREATE TABLE IF NOT EXISTS `nps_response` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `recipient_id` BIGINT UNSIGNED NOT NULL,
  `submitted_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `recipient_id_key` (`recipient_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
""".strip()),
    ("nps_response_answer", """
CREATE TABLE IF NOT EXISTS `nps_response_answer` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `response_id` BIGINT UNSIGNED NOT NULL,
  `question_id` BIGINT UNSIGNED NOT NULL,
  `answer_value` TEXT NULL,
  PRIMARY KEY (`id`),
  KEY `response_id_key` (`response_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
""".strip()),
]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="Create the tables (default is a dry run).")
    args = ap.parse_args()

    cred = get_credential()
    if cred is None:
        raise SystemExit("MYSQL_* credentials not configured.")
    import pymysql
    conn = pymysql.connect(
        host=cred["host"], user=cred["user"], password=cred["password"],
        database=SCHEMA, port=cred["port"], ssl={"ssl": {}}, connect_timeout=15,
    )
    try:
        cur = conn.cursor()
        for table, ddl in TABLES:
            cur.execute(
                "SELECT 1 FROM information_schema.tables WHERE table_schema = %s AND table_name = %s",
                (SCHEMA, table),
            )
            if cur.fetchone():
                print(f"{SCHEMA}.{table} already exists - skipping.")
                continue

            print(f"{'Applying' if args.apply else 'DRY RUN - would apply'}:\n\n{ddl}\n")
            if args.apply:
                cur.execute(ddl)
                conn.commit()
                print(f"Created {SCHEMA}.{table}.")

        if not args.apply:
            print("Re-run with --apply to execute.")
    finally:
        conn.close()


if __name__ == "__main__":
    main()
