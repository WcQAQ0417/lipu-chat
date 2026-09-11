SET NAMES utf8mb4;
SET time_zone = '+08:00';

CREATE TABLE IF NOT EXISTS users (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  public_id CHAR(26) NOT NULL,
  nickname VARCHAR(40) NOT NULL,
  avatar_url VARCHAR(512) NULL,
  status ENUM('ACTIVE', 'BANNED', 'DELETED') NOT NULL DEFAULT 'ACTIVE',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_users_public_id (public_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS personas (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  public_id CHAR(26) NOT NULL,
  owner_user_id BIGINT UNSIGNED NULL,
  name VARCHAR(40) NOT NULL,
  short_description VARCHAR(160) NOT NULL,
  identity_background TEXT NOT NULL,
  speaking_habits JSON NOT NULL,
  attitude_style JSON NOT NULL,
  transform_rules JSON NOT NULL,
  example_dialogues JSON NULL,
  visual_config JSON NULL,
  visibility ENUM('PUBLIC', 'PRIVATE', 'UNLISTED') NOT NULL DEFAULT 'PUBLIC',
  enabled TINYINT(1) NOT NULL DEFAULT 1,
  version INT UNSIGNED NOT NULL DEFAULT 1,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  deleted_at DATETIME(3) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_personas_public_id (public_id),
  KEY idx_personas_enabled_visibility (enabled, visibility),
  KEY idx_personas_owner (owner_user_id),
  CONSTRAINT fk_personas_owner FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT chk_personas_version CHECK (version > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS persona_versions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  persona_id BIGINT UNSIGNED NOT NULL,
  version INT UNSIGNED NOT NULL,
  snapshot JSON NOT NULL,
  created_by BIGINT UNSIGNED NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_persona_version (persona_id, version),
  CONSTRAINT fk_persona_versions_persona FOREIGN KEY (persona_id) REFERENCES personas(id) ON DELETE CASCADE,
  CONSTRAINT fk_persona_versions_creator FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS topic_templates (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  public_id CHAR(26) NOT NULL,
  name VARCHAR(80) NOT NULL,
  description VARCHAR(500) NOT NULL,
  min_players SMALLINT UNSIGNED NOT NULL DEFAULT 2,
  max_players SMALLINT UNSIGNED NOT NULL DEFAULT 12,
  mission_pool JSON NOT NULL,
  win_rule JSON NULL,
  enabled TINYINT(1) NOT NULL DEFAULT 1,
  version INT UNSIGNED NOT NULL DEFAULT 1,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_topic_templates_public_id (public_id),
  KEY idx_topic_templates_enabled (enabled)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS rooms (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  public_id CHAR(26) NOT NULL,
  room_code CHAR(8) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  owner_user_id BIGINT UNSIGNED NOT NULL,
  name VARCHAR(80) NOT NULL,
  room_type ENUM('NORMAL', 'THEME') NOT NULL DEFAULT 'NORMAL',
  topic_template_id BIGINT UNSIGNED NULL,
  status ENUM('ACTIVE', 'EMPTY_GRACE', 'DESTROYING', 'DESTROYED') NOT NULL DEFAULT 'ACTIVE',
  max_members SMALLINT UNSIGNED NOT NULL DEFAULT 30,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  empty_since DATETIME(3) NULL,
  destroy_after DATETIME(3) NULL,
  destroyed_at DATETIME(3) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_rooms_public_id (public_id),
  UNIQUE KEY uk_rooms_code (room_code),
  KEY idx_rooms_cleanup (status, destroy_after),
  KEY idx_rooms_owner_created (owner_user_id, created_at),
  CONSTRAINT fk_rooms_owner FOREIGN KEY (owner_user_id) REFERENCES users(id),
  CONSTRAINT fk_rooms_topic FOREIGN KEY (topic_template_id) REFERENCES topic_templates(id) ON DELETE SET NULL,
  CONSTRAINT chk_rooms_member_limit CHECK (max_members BETWEEN 2 AND 200)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS room_members (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  public_id CHAR(26) NOT NULL,
  room_id BIGINT UNSIGNED NOT NULL,
  user_id BIGINT UNSIGNED NOT NULL,
  current_persona_id BIGINT UNSIGNED NOT NULL,
  member_status ENUM('JOINED', 'LEFT', 'KICKED') NOT NULL DEFAULT 'JOINED',
  joined_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  last_seen_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  left_at DATETIME(3) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_room_members_public_id (public_id),
  UNIQUE KEY uk_room_user (room_id, user_id),
  KEY idx_room_members_user (user_id, member_status),
  CONSTRAINT fk_room_members_room FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE,
  CONSTRAINT fk_room_members_user FOREIGN KEY (user_id) REFERENCES users(id),
  CONSTRAINT fk_room_members_persona FOREIGN KEY (current_persona_id) REFERENCES personas(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS room_missions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  public_id CHAR(26) NOT NULL,
  room_id BIGINT UNSIGNED NOT NULL,
  room_member_id BIGINT UNSIGNED NOT NULL,
  mission_key VARCHAR(80) NOT NULL,
  mission_text VARCHAR(600) NOT NULL,
  mission_payload JSON NULL,
  status ENUM('ASSIGNED', 'COMPLETED', 'FAILED', 'REVEALED') NOT NULL DEFAULT 'ASSIGNED',
  assigned_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  completed_at DATETIME(3) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_room_missions_public_id (public_id),
  UNIQUE KEY uk_room_member_mission (room_id, room_member_id),
  KEY idx_room_missions_status (room_id, status),
  CONSTRAINT fk_room_missions_room FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE,
  CONSTRAINT fk_room_missions_member FOREIGN KEY (room_member_id) REFERENCES room_members(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS messages (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  public_id CHAR(26) NOT NULL,
  client_message_id CHAR(36) NOT NULL,
  room_id BIGINT UNSIGNED NOT NULL,
  room_member_id BIGINT UNSIGNED NOT NULL,
  user_id BIGINT UNSIGNED NOT NULL,
  persona_id BIGINT UNSIGNED NOT NULL,
  persona_version INT UNSIGNED NOT NULL,
  persona_snapshot JSON NOT NULL,
  original_text TEXT NULL,
  transformed_text TEXT NOT NULL,
  content_format ENUM('PLAIN', 'MARKDOWN', 'CODE') NOT NULL DEFAULT 'PLAIN',
  transform_status ENUM('PENDING', 'SUCCEEDED', 'FALLBACK', 'FAILED') NOT NULL DEFAULT 'SUCCEEDED',
  model_trace_id VARCHAR(100) NULL,
  sequence_no BIGINT UNSIGNED NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_messages_public_id (public_id),
  UNIQUE KEY uk_messages_client_id (user_id, client_message_id),
  UNIQUE KEY uk_messages_room_seq (room_id, sequence_no),
  KEY idx_messages_room_time (room_id, created_at),
  CONSTRAINT fk_messages_room FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE,
  CONSTRAINT fk_messages_member FOREIGN KEY (room_member_id) REFERENCES room_members(id),
  CONSTRAINT fk_messages_user FOREIGN KEY (user_id) REFERENCES users(id),
  CONSTRAINT fk_messages_persona FOREIGN KEY (persona_id) REFERENCES personas(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

