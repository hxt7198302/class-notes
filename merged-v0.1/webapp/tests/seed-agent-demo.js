'use strict';
// 生成演示会话（零依赖，直接写 data/agent/<id>/，方便前端 /api/notes、/api/note、/api/source 联调）
// 用法：node tests/seed-agent-demo.js
//      DATA_DIR=<临时目录> node tests/seed-agent-demo.js
// 说明：只覆盖演示会话自己的目录，不动其它会话。

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, 'data');
const ID = 'c20261024-180000-demo';
const DIR = path.join(DATA_DIR, 'agent', ID);
const FILES = path.join(DIR, 'files');

function writeJSON(name, obj) {
  fs.writeFileSync(path.join(DIR, name), JSON.stringify(obj, null, 2), 'utf8');
}

function main() {
  fs.mkdirSync(FILES, { recursive: true });

  const startedAt = new Date('2026-10-24T18:00:00+08:00').getTime();
  const durationMs = 45 * 60 * 1000;
  const endedAt = startedAt + durationMs;
  const now = Date.now();

  const transcriptText = [
    '今天我们讲软件需求工程。需求分析的第一步是把用户想要的东西写清楚，而不是急着想代码怎么写。',
    '用例图描述的是参与者和系统之间的交互，参与者不一定是人，也可能是另一个系统。',
    '需求变更不可避免，所以要有变更记录，每次变更都要说明原因和影响范围。',
    '下周的小组作业是给一个校园场景做需求规格说明书，重点是把功能需求和非功能需求分开写。',
    '最后提醒一下，期中考试范围是前三章，重点看需求获取和用例建模。'
  ].join('');

  const meta = {
    id: ID,
    schemaVersion: 1,
    course: '软件工程',
    courseName: '软件工程',
    teacher: '王老师',
    room: '实验楼 B203',
    startedAt: startedAt,
    endedAt: endedAt,
    durationMs: durationMs,
    device: '演示数据（seed-agent-demo）',
    segments: [
      { name: 'recording_00.m4a', startOffsetMs: 0 },
      { name: 'recording_01.m4a', startOffsetMs: 1350000 }
    ],
    photos: [
      { name: 'photo_001.jpg', offsetMs: 300000, takenAt: startedAt + 300000 },
      { name: 'photo_002.jpg', offsetMs: 1200000, takenAt: startedAt + 1200000 },
      { name: 'photo_003.jpg', offsetMs: 2100000, takenAt: startedAt + 2100000 }
    ],
    markers: [
      { offsetMs: 420000, type: '重点', note: '需求分析先写清楚，不要急着写代码', createdAt: startedAt + 420000 },
      { offsetMs: 1980000, type: '作业', note: '校园场景需求规格说明书，功能/非功能分开写', createdAt: startedAt + 1980000 }
    ],
    transcript: {
      text: transcriptText,
      segments: [
        { s: 0, e: 12.5, t: '今天我们讲软件需求工程。需求分析的第一步是把用户想要的东西写清楚，而不是急着想代码怎么写。' },
        { s: 12.5, e: 24.8, t: '用例图描述的是参与者和系统之间的交互，参与者不一定是人，也可能是另一个系统。' },
        { s: 24.8, e: 37.2, t: '需求变更不可避免，所以要有变更记录，每次变更都要说明原因和影响范围。' },
        { s: 37.2, e: 49.6, t: '下周的小组作业是给一个校园场景做需求规格说明书，重点是把功能需求和非功能需求分开写。' },
        { s: 49.6, e: 62.0, t: '最后提醒一下，期中考试范围是前三章，重点看需求获取和用例建模。' }
      ],
      model: 'demo-transcript',
      tookMs: 12345,
      at: endedAt + 60000,
      polished: false
    },
    transcriptStatus: 'done',
    createdAt: now,
    updatedAt: now
  };

  const status = {
    state: 'done',
    course: meta.course,
    title: '软件需求工程：用例图与需求变更',
    summary: '需求分析的写法、用例图的参与者、需求变更记录，以及小组作业与期中范围提醒。',
    progress: 100,
    updatedAt: new Date(now).toISOString()
  };

  const items = [
    {
      title: '校园场景需求规格说明书（功能/非功能需求分开写）',
      category: '作业',
      due: '2026-10-31',
      urgent: true,
      quote: '重点是把功能需求和非功能需求分开写。',
      offsetSec: 37.2,
      research: false,
      researchQuery: '',
      done: false
    },
    {
      title: '期中考试复习：前三章（需求获取、用例建模）',
      category: '考试',
      due: '2026-11-08',
      urgent: false,
      quote: '期中考试范围是前三章，重点看需求获取和用例建模。',
      offsetSec: 49.6,
      research: true,
      researchQuery: '软件工程 需求获取 用例建模 复习提纲',
      done: false
    }
  ];

  const noteMarkdown = [
    '# 软件工程 · 需求分析（演示笔记）',
    '',
    '> 时间：2026-10-24 18:00 · 45 分钟 · 演示会话 ' + ID,
    '',
    '## 一、需求分析先写清楚',
    '',
    '- 先把用户想要的东西写清楚，不要急着想代码怎么写。',
    '- 功能需求与非功能需求要分开写。',
    '',
    '## 二、用例图',
    '',
    '- 描述参与者与系统之间的交互。',
    '- 参与者不一定是人，也可能是另一个系统。',
    '',
    '## 三、需求变更',
    '',
    '- 变更不可避免，每次变更都要记录原因和影响范围。',
    '',
    '## 四、作业与考试',
    '',
    '| 事项 | 截止 |',
    '| --- | --- |',
    '| 校园场景需求规格说明书 | 2026-10-31 |',
    '| 期中复习（前三章） | 2026-11-08 |',
    ''
  ].join('\n');

  const demoText = [
    '课堂助手 · 演示素材',
    '会话：' + ID,
    '用途：给 /api/file 与 HTTP Range 联调（可直接用 curl -H "Range: bytes=0-9" 验证 206）。',
    '这一行之后的内容用于测试断点续播。',
    ''
  ].join('\n');

  writeJSON('meta.json', meta);
  writeJSON('status.json', status);
  writeJSON('items.json', items);
  fs.writeFileSync(path.join(DIR, 'note.md'), noteMarkdown, 'utf8');
  fs.writeFileSync(path.join(DIR, 'complete.flag'), new Date(now).toISOString(), 'utf8');
  fs.writeFileSync(path.join(FILES, 'demo.txt'), demoText, 'utf8');

  console.log('已生成演示会话：' + ID);
  console.log('数据目录：' + DIR);
  console.log('文件：meta.json / status.json / items.json / note.md / complete.flag / files/demo.txt');
  console.log('联调：GET /api/notes、/api/note?id=' + ID + '、/api/source?id=' + ID + '、/api/file?id=' + ID + '&name=demo.txt');
}

try {
  main();
} catch (e) {
  console.error('生成演示会话失败：' + (e && e.stack || e));
  process.exit(1);
}
