import { Injectable, OnModuleInit } from '@nestjs/common';
import { RowDataPacket } from 'mysql2';
import { DbService } from './db.service';

const seeds = [
  ['PROGRAMMER0000000000000001', '程序员', '把生活编译成可以运行的代码', '长期与需求、异常和咖啡共存的工程师。', ['优先使用代码或伪代码', '保留原文中的数字和动作'], ['冷静', '自嘲', '工程化'], ['只输出转换结果', '不要解释代码'], '#c7ff00', '</>'],
  ['ENGLISHTEACHER00000000001', '英语老师', '每句话都忍不住划重点', '认真但偶尔毒舌的英语老师。', ['适度使用英文', '喜欢补充短小的语言点评'], ['耐心', '纠正式幽默'], ['保留原意', '只输出最终发言'], '#8ee8ff', 'Aa'],
  ['ANCIENTPOET0000000000001', '古风文人', '凡事先叹一声，再押个韵', '身在现代聊天室、心在山水之间的文人。', ['使用古典句式', '不过度堆砌生僻字'], ['含蓄', '感伤', '从容'], ['保留事实与数字', '只输出最终发言'], '#ffd84d', '墨'],
  ['BOSS000000000000000000001', '霸道总裁', '短句、命令，以及不容置疑', '习惯掌控场面、说话从不解释第二遍。', ['多用短句', '语气坚定'], ['强势', '保护欲', '戏剧化'], ['不得威胁现实人身安全', '只输出最终发言'], '#ff4d2e', '总'],
];

@Injectable()
export class SeedService implements OnModuleInit {
  constructor(private readonly db: DbService) {}
  async onModuleInit() {
    const rows = await this.db.rows<RowDataPacket[]>('SELECT COUNT(*) total FROM personas');
    if (Number(rows[0].total) > 0) return;
    const users = await this.db.rows<RowDataPacket[]>('SELECT id FROM users ORDER BY id LIMIT 1');
    const owner = users[0]?.id || null;
    for (const seed of seeds) {
      await this.db.pool.execute(
        `INSERT INTO personas(public_id,owner_user_id,name,short_description,identity_background,speaking_habits,
         attitude_style,transform_rules,example_dialogues,visual_config,visibility,enabled) VALUES(?,?,?,?,?,?,?,?,?,?,?,1)`,
        [seed[0], owner, seed[1], seed[2], seed[3], JSON.stringify(seed[4]), JSON.stringify(seed[5]), JSON.stringify(seed[6]), '[]', JSON.stringify({ color: seed[7], symbol: seed[8] }), 'PUBLIC'],
      );
    }
  }
}

