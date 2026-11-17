# FPWIN Pro 7 `.pro` 文件格式解析说明

> 适用对象：Panasonic Control FPWIN Pro 7（v7.5.2.0，CoDeSys 2.3 血统）保存的二进制工程文件 `*.pro`。
> 本文记录的是**离线逆向**得出的容器结构与对象记录布局，配套实现见
> [lib/proparse.js](lib/proparse.js)、[proparse-cli.js](proparse-cli.js) 和 MCP 工具 `fpwin_pro_parse`。
> 全部结论都用 `D:\FP7752\Samples\English` 里 **27 组 `.pro`/`.asc` 对照样本**验证过，
> 并对本机可得的 **42 个容器**（27 组样本 + 7 个夹具 + `Mak` + 7 个额外工程）做了全量解析审计
> （见 §7、§10）。

---

## 1. 总体结构

`.pro` 是一个按 **0x800 字节页**对齐的 SC（Structured Container）二进制容器。
文件 = 1 页文件头 + 一串**帧（frame）**；帧与帧之间紧密排列，页边界处用 `0xFF` 填充。

```
+----------------------+ 0x0000
| 文件头 (0x800 字节)   |
+----------------------+ 0x0800   ← 第一帧开始，之后是连续帧链
| FE FE 31 00 ...      | 页/目录头帧
| FA FA 91 01 ...      | SC 块帧（对象 / 数据 / 交叉引用）
| FA FA 4D 00 ...      |
| 0xFF 填充            | 补齐到下一个 0x800 边界
| FE FE 00 08 ...      | 2048 字节的数据页帧
| ...                  |
+----------------------+ usedLength（文件尾）
| 0xFF 填充            |
+----------------------+ 文件尺寸（0x800 的整数倍，样本均为 131072）
```

### 1.1 文件头（0x0000–0x07FF）

| 偏移 | 类型 | 值（Flasher 样本） | 含义 |
|---|---|---|---|
| `+0x00` | u32 | `0x0001FFFF` | **文件长度 − 1**（不是魔数；见下） |
| `+0x08` | u32 | `0x00018E14` | **已用长度 usedLength**（帧链终点；其后全是 `0xFF`） |
| `+0x0C` | u32 | `0x00000800` | 页大小 = 2048 |
| `+0x10`… | u32 | `0x0B`, `0x0E`, … | 其余头部字段语义未定，解析时可忽略 |

> **`u32@0` 是文件长度 − 1，不是魔数**（2026-11-17 修正）：43 个容器（65536 B … 3244032 B）
> **43/43 精确等于 `size − 1`**。样本都是 131072 B，所以读出来是 `0x0001FFFF`，早期笔记误当成
> “低 16 位恒为 `FFFF` 的魔数”。真正的判定是 `长度 ≥ 0x800`、`长度 % 0x800 == 0`、
> `u32@0 == size − 1`、`u32@8` 落在 `(0x800, size]`。
> 旧判据直接拒收任何长度不是 64 KiB 整数倍的工程——本机 4 个客户工程（1212416 B / 3244032 B）
> 全部被误判为“bad magic 0x127FFF / 0x317FFF”。

### 1.2 帧格式

```
+0x00  u16  tag    0xFAFA = SC 块；0xFEFE = 页/目录头
+0x02  u16  len    整帧长度（含 tag+len 这 4 字节）
+0x04  ...  payload (len-4 字节)
```

`FE FE` 帧是**固定大小的表目录（catalogue）**，与工程大小无关：42 个容器（64 KiB … 3.1 MiB，
32 … 1584 页）实测每个容器 18 个 `FE FE` 帧，形状恒为 **6 / 5 / 5 / 2**
（41/42 个文件；唯一例外是一个被 7.5→7.7 升级保存过的工程，多一条版本记录，2 → 3）：

| len | 每个容器 | 内容 |
|---|---|---|
| 31 | 6 | 表目录项：`+0x0A` = 页号 0,2,4,…,10，`+0x12` 指向**同页号**的页帧 |
| 50 | 2 | `SC!VERS`：ASCII `SC!VERS`@`+0x1E`、版本串@`+0x28`（`6.00.00` / `7.5.0.0` / `7.7.4.0`） |
| 2048 | 5 + 5 | 5 个带 `FC!DEF` 头（`+0x1E`，`+0x1A`=1，每个 SC 表一页）；5 个紧随 31 字节头之后全是 `0xFF` 的保留页（`+0x1A`=0） |

三条已证规律（42 个容器全部成立）：

1. **`+0x06` = 该帧页内已用字节 − 22**：目录项 `31−22=9`、保留页 `31−22=9`、
   `SC!VERS` `50−22=28`、`FC!DEF` 页 `2048−22=2026`。
2. **目录项与页帧互相指向**：目录项 `+0x12` → 页帧；页帧 `+0x12`（与 `+0x0E` 恒相等）→ 回目录项；
   保留页指向自身（`+0x12 == 自身偏移`）。
3. **`+0x0A` 是共享页号**：偶数号 = 「目录项 ↔ 已用页」成对，奇数号 = 保留页；页号 0 的目录项
   指向版本记录。`+0x1A`：已用页 1、保留页 0。

合计：42 个容器共 **758 个 `FE FE` 帧**，其中 41 个容器恰为 18 帧（6/5/5/2）；
一个被 7.5→7.7 升级保存过的工程是 20 帧（多一条版本记录，另有一个 **140 字节**的已用页，
`+0x06`=118）。即**页帧长度不必然是 2048**：已用页按实际用到的字节数分配，保留页才占满 2048。

这 18 个帧就是**整个文件的表目录**；`0x800` 对齐只对这一块成立（28 个样本里 363/504 帧在边界上），
**数据区的 `FA FA` 帧可以自由跨越 `0x800` 页边界**（样本里 15 个、3.1 MiB 工程里 282 个帧跨页）。
所以 `FE FE` 不是“页起始标记”，而是与 `FA FA` 并列的一种**帧种类**。

> 判据（见 §6）：`FE FE` 出现在压缩数据里时会产生假帧——只有 `+0x06` 为 `9` 或 `len−22` 的才是真页帧。
> 大工程里这条过滤剔掉了最多 23 个假页帧，并让内容帧恢复量增加 124–596 个。

`FA FA` 帧承载全部记录。`len` 最小的合法值是 8。

### 1.2.1 `FC FC`：7.7 的内容记录帧

7.7.4.0 起的工程把**内容记录**写成 `FC FC` 帧（tag `0xFCFC`）。payload 布局与 kind 4 数据帧
一致，只是 tag 不同、并在帧头里多写了解压后长度：

| 偏移 | 内容 |
|---|---|
| +0x00 | `FC FC` |
| +0x02 | u16 len（整帧长度，含 4 字节 tag+len） |
| +0x0A | u32 内容种类（实测 2068/2068 恒为 4） |
| +0x0E | u32 前一条记录的帧偏移（回链，指向同族的上一帧起点） |
| +0x12 | u32 记录 id（任务设置帧引用的就是它） |
| +0x16 | u32 所属对象 id（任务绑定帧 = 任务对象） |
| +0x1A | u32 子类（实测 50 / 51） |
| +0x1E | u16 恒为 `0x0040` |
| +0x20 | u32 **解压后长度**（2067/2067 与 zlib 输出逐帧相等） |
| +0x24 | zlib 流 |

判据（解析器 `looksLikeContentRecord`）：种类 ∈ {4,6,10}、`+0x1E == 0x40`、
`+0x12` / `+0x16` ≤ `0x100000`。42 个容器共 2113 条通过校验，其中 2068 条在 7.7 样本里。

一条实际记录（客户甲 7.7.4.0，记录 id 2036，全局变量声明）：

```
fc fc 6d 00                        tag + len = 109
00 00 00 00 00 00                  +0x04…+0x09 全 0
04 00 00 00                        +0x0A 内容种类 4
23 15 07 00                        +0x0E 前一条记录 0x71523
f4 07 00 00                        +0x12 记录 id = 2036
04 00 00 00                        +0x16 所属对象 id = 4
33 00 00 00                        +0x1A 子类 51
40 00                              +0x1E 0x0040
56 00 00 00                        +0x20 解压后 86 字节
78 9c e3 64 60 60 …                zlib → 一条 VAR_GLOBAL 声明记录
```

> **为什么必须识别**：只认 `FA FA`/`FE FE` 的解析器走到 7.7 的第一条 `FC FC` 就退化为逐字节
> 扫描，随后压缩流里偶然出现的 `FA FA` 字节对（`0x723BE`，长度由后两字节凑成 42007）被当成
> 真帧，一口气吞掉 42 KB 记录——落在里面的 11 条任务绑定记录全部不可见。识别 `FC FC` 后该工程
> 记录数 **2920 → 5036**、内容帧 **2571 → 4686**，对象数不变（233），任务程序名 **0 → 9**。
> 副作用只有正向：`Control of two tanks` 三个样本各多出 4 条 `FC FC` 记录、`4.06/4.12` 各 +2，
> 派生输出（声明/任务/SFC）零变化。

---

## 2. SC 块：对象记录布局

带名字的 `FA FA` 帧就是**对象记录**。Flasher 样本里 `FlasherSolution1` 的原始字节：

```
00bb5c  fa fa 4d 00 00 00 3b 00 00 00 02 00 00 00 15 bb
00bb6c  00 00 d7 00 00 00 06 00 00 00 0f 00 00 00 96 2a
00bb7c  f3 48 00 00 00 00 08 0c 06 10 00 00 00 46 00 6c
00bb8c  00 61 00 73 00 68 00 65 00 72 00 53 00 6f 00 6c
00bb9c  00 75 00 74 00 69 00 6f 00 6e 00 31 00
```

字段表（偏移相对**帧起始**）：

| 偏移 | 类型 | 样本值 | 含义 | 置信度 |
|---|---|---|---|---|
| `+0x00` | u16 | `FA FA` | 帧 tag | 已证 |
| `+0x02` | u16 | `0x004D`=77 | 整帧长度 | 已证 |
| `+0x04` | u16 | `0000` | 恒为 0 | 已证 |
| `+0x06` | u32 | `0x3B`=59 | size hint（关联数据长度，用途未定） | 观察 |
| `+0x0A` | u32 | `2` | 样本中恒为 2 | 已证 |
| `+0x0E` | u32 | `0xBB15` | **prev**：帧链中上一条记录的文件偏移 | 已证 |
| `+0x12` | u32 | `0xD7` | **对象 id**（工程内唯一） | 已证 |
| `+0x16` | u32 | `6` | **父对象 id**（0 = 工程根） | 已证 |
| `+0x1A` | u32 | `0x0F` | **对象类型码**（见 §3） | 已证 |
| `+0x1E` | u32 | `0x48F32A96` | **对象最后修改时间（Unix 秒）** | 已证 |
| `+0x22` | u32 | `0` | 恒为 0 | 已证 |
| `+0x26` | u8 | `08` | 属性字节 0（标志位，未定） | 观察 |
| `+0x27` | u8 | `0C` | 属性字节 1（标志位，未定） | 观察 |
| `+0x28` | u8 | `06` | 属性字节 2（类别/子类型，未定） | 观察 |
| `+0x29` | u8 | `0x10`=16 | **名字长度（UTF-16 字符数）** | 已证，关键 |
| `+0x2A` | 3×u8 | `00 00 00` | 定长零填充 | 已证 |
| `+0x2D` | UTF-16LE | `"FlasherSolution1"` | **对象名**（`+0x29` 个字符） | 已证 |

> **`+0x29` 名字长度是解析的关键**：早期实现“名字一直延伸到帧尾”，在部分工程上会把
> 帧尾陈旧字节并进名字，得到 `"blinking I/O Map"`、`"HS_Counterogram"` 这类脏名字。
> 按 `+0x29` 截断后，27 组样本全部干净。

> **`+0x1E` 是修改时间，不是校验和**（2026-11-17 归因）：28 个工程（
> `D:\FP7752\Samples\English` 的 27 组 + `D:\FP7752\Mak\EmptyPrj.pro`）共 **5617 条对象记录，
> 5617/5617 全部落在 2005–2030 的 Unix 秒区间**，只有 **1 条为 `0`**（EmptyPrj 里从未写过的对象）。
> 每个工程内部都有多个不同取值，而且**根对象（`parent == 0`）恒为全工程最大值 = 工程最后保存时间**
> （28/28）。27 组样本中 26 组共享同一个最小值 `2008-09-29T15:08:53`（模板工程的出生时间），
> 例外是 Coffee machine（`2011-07-07` … `2011-10-04`）；`EmptyPrj.pro` 为 `2020-06-08`。
> 复现：`node work/mtime-probe.js` → `total=5617 zeros=1 outside2005-2030=0`。
> 解析器同时以 `mtime` / `mtimeIso` 导出这两个值，旧键名 `checksum` 保留以兼容既有调用方。

### 2.1 无名字的块

`+0x29 == 0` 的 `FA FA` 帧是**数据/交叉引用记录**（声明、内容、跨引用等），同样带
id/parent/type 头但无名字，当前解析器只登记它们的偏移与长度，不解释内容。

### 2.2 帧尾陈旧字节

按 `+0x29` 取名字后，帧尾可能还剩若干字节（`extraBytes`）。这些字节是残留/复用缓冲区
内容，**不属于名字**，解析时忽略。

### 2.3 SC 表目录（`.dat` / `.idx` 记录）

每个容器有 **10 条 401 字节的表记录**（40/42 个文件；两个客户工程省略了空的
`SCDECL_TAB.dat`），成对覆盖 5 张 SC 表：`SCOBJ_TAB`（对象）、`SCDECL_TAB`（声明）、
`SCCONT_TAB`（内容）、`SCCOM_TAB`（注释）、`SCCRL_TAB`（交叉引用）。

帧布局（偏移相对帧起始，42/42 个容器一致）：

| 偏移 | 类型 | 值 | 含义 |
|---|---|---|---|
| `+0x00` | u16 | `FA FA` | 帧 tag |
| `+0x02` | u16 | `0x0191` = 401 | 帧长（所有工程、所有版本都是 401） |
| `+0x04` | u16 | 0 | |
| `+0x06` | u32 | 383 | = 帧长 − 18 |
| `+0x0A` / `+0x0E` | u32 | 0 | |
| `+0x12` | ASCII | `SCOBJ_TAB.dat` | 表名，空格补齐到 **0xFF** 字节 |
| `+0x111` | 128 B | 表描述符 | 见下 |

表描述符（偏移相对帧起始 `+0x111`）：

| 偏移 | 类型 | 含义 | 证据 |
|---|---|---|---|
| `+0x00` | u32 | 格式标记：`0xFFFFFFFF`（6.00 文件）/ `0x07ED`（7.5、7.7 文件） | 与 `+0x08` 恒相等，42/42 |
| `+0x04` | u32 | 0 | 42/42 |
| `+0x08` | u32 | 同 `+0x00` | 42/42 |
| `+0x0C` | u32 | 该表的页帧偏移：`.dat` → 31 字节目录项；`.idx` → 保留页 | 42/42 都落在真实 `FE FE` 帧上（§1.2） |
| `+0x10` | u32 | 追加偏移 = 该表最后一条记录的偏移 | `SCOBJ_TAB.dat` 41/42 等于最后一个对象记录的偏移 |
| `+0x14` | u32 | id 计数器：`.dat` = 已分配的最大 id（41/42 等于最大对象 id，或 +1）；`.idx` 恒 0 | 42/42 |
| `+0x18` | u32 | 次级计数器（`.idx` 像索引 id 上界，`.dat` 多为 0/47/11；语义未定） | 观察 |
| `+0x1C` | u32 | 表码（6.00 文件 `0x15812`，7.5/7.7 文件 `0xC812` 等） | 按版本不同 |
| `+0x70` | u32 | 该表最后写入时间（Unix 秒） | 42/42 中最大值 == 根对象 mtime |

> **`.idx` 页永远是空的**：42/42 个容器的 `.idx` 描述符 `+0x0C` 都指向那 5 个 `0xFF`
> 保留页，`+0x10`/`+0x14` 都是 0。即 FPWIN 只写 `.dat` 侧数据，**索引在打开/编译时重建**，
> 磁盘上不存在非空的索引项样本（`SCOBJ_TAB.idx` 等从未被填充）。
> 解析器实际按帧遍历，不依赖这张目录；`tables(buf, project)` 只是把它暴露出来供核对。
> CLI 侧：`--tables` 打印这张目录，`--json` 输出 `tables` 数组（并计入 `counts.tables`），
> 默认摘要多一行 `catalogue …`。

---

## 3. 对象类型码

对象树用 `+0x1A` 的类型码区分种类。`0x0F/0x10/0x11` 用 `.asc` 导出做归因验证：
27 组样本里逐个把 `PROGRAM / FUNCTION_BLOCK / FUNCTION` 名字映射回 `.pro` 记录，
**71 个 PROGRAM 全部是 0x0F、22 个 FUNCTION_BLOCK 全部是 0x10、22 个 FUNCTION 全部是 0x11，零冲突**
（脚本：[tools/typecensus.js](tools/typecensus.js)）。

| 类型码 | 含义 | 依据 |
|---|---|---|
| `0x00` | 工程根（`Projekt` / `Project`） | 根对象，`parent=0` |
| `0x02` | PLC 配置节点（`SPS`） | 树结构 |
| `0x03` | DUT 文件夹（`DUTs`） | 树结构 |
| `0x04` | POU 文件夹（`POEs` / `POUs`） | 树结构 + 子对象全是 POU |
| `0x06` | 段（section）/ 动作对象（SFC `Actions` 下） | 树结构 |
| `0x07` | 段：FBD 程序体（`Rumpf`） | 语言归因，§5 |
| `0x08` | 段：SFC 图（`Body` / `Rumpf`） | §5.7，二进制元素流 |
| `0x09` | SFC 动作文件夹（`Actions`） | §5.7 |
| `0x0A` | SFC 转移文件夹（`Transitions`） | §5.7 |
| `0x0B` | 段：声明头（`Kopf`、`KopfMap`） | 树结构 |
| `0x0D` | 全局变量表（`Glob. Variablens`） | 树结构 |
| `0x0E` | 程序/中断容器（`Programs`、`Interrupt N`） | 树结构 |
| **`0x0F`** | **PROGRAM** | 27 组 `.asc` 归因，71/71 |
| **`0x10`** | **FUNCTION_BLOCK** | 27 组 `.asc` 归因，22/22 |
| **`0x11`** | **FUNCTION** | 27 组 `.asc` 归因，22/22 |
| `0x12` | 任务表（`Tasks`） | 树结构 |
| `0x13` | 段：程序体（`ROM_Config`、`ROM_Header`） | 树结构 |
| `0x14` | 编译结果（`Compile_Result`） | 树结构 |
| `0x15` | 符号表（`The_Symbol_Table`） | 树结构 |
| `0x16` | 库（`Libraries`） | 树结构 |
| `0x21` | SFC 步文件夹（`Steps`，样本里是空表） | §5.7 |
| `0x6x` / `0x3x` | PLC 配置条目（`ROM_*`、`Slave I/O Map`、`MEWNET-*`、`PROFIBUS` 等） | 树结构，语义未细分 |

样本工程根名有德语 `Projekt` 与英语 `Project` 两种（取决于工程创建模板），解析时都接受。

---

## 4. 对象树重建

- `parent` 指向父对象 id，`parent = 0` 的即工程根；全部记录按 id 建索引后成树。
- `prev` 是文件内的**追加链表**指针（用于写出时定位），与树结构无关。
- POU 的父节点是 POU 文件夹（`0x04`）；POU 下的 `Kopf`/`KopfMap`/`Rumpf`/`A_STREAM`
  等是其声明段与程序体段。

Flasher 样本解析结果（节选）：

```
Projekt [project, id=0x3, @0xc6f5]
  SPS [plc-config, id=0x23]
    E/A-Adressen             [type:0x36]   ← PLC 地址表
    Fieldbus Master Unit     [type:0x46]
    MEWNET-F E/A-Adressen    [type:0x34]
      Slave I/O Map          [type:0x35] ×N
  Tasks     [tasks, id=0x7]
    Programs / Programs 2 / Interrupt 0…23
  POEs      [folder:pous, id=0x6]
    FlasherSolution1 [program, id=0xd7, @0xbb5c]
      KopfMap [section:header, id=0xd8]
    FlasherSolution2 [program, id=0xdb, @0x17543]
  DUTs      [folder:duts, id=0x5]
  Glob. Variablens [globals, id=0x4]
```

---

## 5. 内容帧：源码（zlib + UTF-16LE）

对象记录只描述树结构；**段内容**（程序体、配置、地址表）放在紧随其后的**无名字内容帧**里，
正文是 **zlib 压缩的 UTF-16LE 文本**。FlasherSolution1 的程序体帧：

```
0177c8  fa fa 37 00 | 00 00 | 25 00 00 00 | 02 00 00 00 | c5 75 01 00 | ...   ← Rumpf 段记录（对象帧）
0177ff  fa fa 1a 03 | 00 00 | 08 03 00 00 | 06 00 00 00 | d3 72 01 00 | de 00 00 00 |
        00 00 00 00 | 04 fd ff ff | 82 0c 00 00 | 78 9c ed 55 ...              ← 内容帧：+0x22 起是 zlib
```

内容帧字段（偏移相对帧起始）：

| 偏移 | 类型 | 说明 |
|---|---|---|
| `+0x00` | u16 | `FA FA` |
| `+0x02` | u16 | 帧长 |
| `+0x04` | u16 | 0 |
| `+0x06` | u32 | size hint |
| `+0x0A` | u32 | **kind**：`6` = 文本内容（BODY / 配置），`4` = 二进制（地址流/表） |
| `+0x0E` | u32 | prev：同一段的上一条内容帧偏移（链式） |
| `+0x12` | u32 | **ownerId**（kind 6）：所属段对象的 id（如 `Rumpf`、`Body`） |
| `+0x16` | u32 | **ownerId**（kind 4）：所属段对象的 id（如 `Kopf`、`A_STREAM`） |
| `+0x1E` | u32/u16 | 解压后长度提示 |
| `+0x20`/`+0x22` | — | zlib 流起点：**按 kind 固定**（kind 10 = `+0x1A`，kind 6 = `+0x22`，kind 4 = `+0x24`） |

zlib 起点的实测分布（42 个容器）：kind 4 → `+0x24` 15704 帧、kind 6 → `+0x22` 8290 帧、
kind 10 → `+0x1A` 632 帧，另有 15 帧落在别处（多为 id 长成这样：`id = 0x0178` 的字节是
`78 01`，盲扫会把它当成 zlib 头）。解析器现在**先按 kind 试固定偏移，失败才回退到
`+0x12…+0x40` 扫描**；这一改动只**新增** 8 条内容帧（0 条被改、0 条丢失），
连带恢复 5 条变量声明。

解压后的文本形如：

```
BODY
    WORKSPACE
        NETWORK_LIST_TYPE := NWTYPELD ;
        ACTIVE_NETWORK := 0 ;
    END_WORKSPACE
    NET_WORK
        ...
B(B_F,TM_100ms,,8,0,16,5,);
B(B_CONTACT,,tmp,4,1,6,3,N);
        END_NETWORK_BODY
    END_NET_WORK
END_BODY
```

与 `.asc` 导出的 `BODY…END_BODY` 段**同一种方言**，可直接对照。

### 5.1 程序体段的命名不固定

程序体所在段的**名字与段类型码随语言/工程而变化**，不能按名字找：

| 工程类型 | 段名 | 段类型码 | 内容 |
|---|---|---|---|
| LD / SFC 动作 | `Rumpf` | `0x06` | 文本 BODY |
| FBD | `Rumpf` | `0x07` | 文本 BODY |
| SFC 动作/转换 | `Body` | `0x06` | 文本 BODY |
| 头/声明 | `Kopf` / `Header` | `0x0B` | 二进制（变量声明结构） |
| 地址流 | `A_STREAM` | `0x13` | 二进制（符号/地址表） |

实现上按**内容**定位：遍历 POU 的子段，取解压后以 `BODY` 开头的文本块作为程序体。

### 5.2 源码验证

`test/parse-source.js` 把 `.pro` 里重建的程序体与 `.asc` 的 `BODY…END_BODY` 对照：

| 指标 | 结果 |
|---|---|
| 27 组配对工程 | **79/79 个有文本体的 POU 全部一致**（63 个逐字节相同 + 16 个仅差导出器重新生成的引脚参数） |
| 无文本体的 POU | 4 个（SFC 主图/图本身是二进制图结构，非文本） |
| 归一化说明 | `.asc` 导出会把 `?Dstart?HNum…` 这类引脚参数补写出来、把特殊字符写成 `U+FFFD`，因此对照时剔除引脚参数、非 ASCII 归一 |

> 注意：**变量声明不是在文本里**。`Kopf` 段是二进制结构（可见 `u32 nameLen + UTF-16 名字 + 类型/标志` 的记录串），
> 变量名/类型/初值需要继续解这张表；目前解析器只暴露段内容原文与符号表字符串。

### 5.3 变量声明记录（`Kopf` / `Header` 段）

程序体是文本，**变量声明是二进制记录**：`Kopf`/`Header` 段每个内容帧承载一条变量记录，
变长、字段顺序固定（`Output_0` 实例，114 字节）：

```
08 00 00 00                u32 名字长度 = 8
"Output_0"                 UTF-16LE 变量名
ff ff ff ff                u32 typeRef（-1 = 类型在下面内联给出；否则是 UDT id）
00 00                      u16 flags
0f 00 00 00 "Output 0 of PLC"   u32 长度 + UTF-16 注释（可为空：长度 0 且无字节）
04 00 00 00 "BOOL"              u32 长度 + UTF-16 类型名
05 00 00 00 "FALSE"             u32 长度 + UTF-16 初值（无初值给 "0" 或空）
0c 00 00 00 "VAR_EXTERNAL"      u32 长度 + UTF-16 作用域
```

- 解析策略：读到帧尾，把字符串序列**从后往前**分配为 `作用域 / 初值 / 类型名 / 注释`；
  空注释只表现为一个 `u32 0`，因此记录是变长的。
- 作用域取值：`VAR`、`VAR_INPUT`、`VAR_OUTPUT`、`VAR_IN_OUT`、`VAR_TEMP`、`VAR_EXTERNAL`、
  `VAR_GLOBAL`、`VAR_STAT`、`VAR_RETAIN`。
- `Kopf` 段的第一个内容帧通常是**元数据块**（一串 id），不是变量记录，解析器会跳过。

补充规则（本轮补齐，来自 863 条记录的实测分布）：

- **注释槽可省略**：无注释的记录直接以类型名开头（如 Coffee machine 的全局变量 `credit`），
  有注释时为 `u32 长度 + UTF-16`；注释为空时可能出现一个 `u32 0` 空槽。
- **空 AT 槽**：全局变量声明了地址时地址串位于初值之后、作用域之前（`… "FALSE" "%IX0.0"
  "VAR_GLOBAL"`）；未声明地址时**可能写一个空串占位**，例如
  `credit` 的 `["", "INT", "0", "", "VAR_GLOBAL"]`。判别方法：仅当空串前两个 token
  分别是「初值字面量」和「合法类型名」时才把它当作空 AT 槽，否则按空初值处理
  （`["", "TON", "", "VAR"]` 是初值为空的 FB 实例）。
- **作用域 `VAR_CONSTANT`**：`.asc` 打印成 `VAR CONSTANT`，`.pro` 存下划线形式。
  之前把 `VAR_CONSTANT` 当非法作用域，导致 `Plc_Time_Fb` 的 5 条常量漏解。

#### 7.7.x 方言：带 GUID 的记录（2026-11-17 新增）

7.7 版工程把 `u16 flags` 换成了一个**每记录 GUID**，其余字段顺序不变：

```
08 00 00 00                u32 名字长度 = 8
"hexValue"                 UTF-16LE 变量名
fe ff ff ff                u32 0xFFFFFFFE（= "类型内联 + 后面跟 GUID"）
26 00 00 00                u32 GUID 长度 = 38
"{1206E77C-…-9C82FFECBB6A}"  UTF-16 GUID + 2 字节 NUL
00 00 00 00                u32 长度 0（空注释槽）
09 00 00 00 "STRING[4]"        类型名
02 00 00 00 "''"               初值
09 00 00 00 "VAR_INPUT"        作用域
```

- 判别：名字之后的 u32 是 `0xFFFFFFFE`（6.00/7.5 文件是 `0xFFFFFFFF`）。
- 布局已验证到字节级：一个 7.7.4.0 工程的 **1589/1589 条**记录都**恰好消费完**各自的内容帧，
  0 字节残留；解出的 1097 条具名记录 + 527 条全局变量记录作用域分布正常
  （`VAR`/`VAR_EXTERNAL`/`VAR_EXTERNAL_RETAIN`/`VAR_INPUT`/`VAR_OUTPUT`/`VAR_RETAIN`）。
- 支持前该工程解出 **0** 条声明（记录以 `0xFFFFFFFE` 开头，被当成非法 typeRef 丢弃）；
  现在 14 个 POU 的 2084 条声明/全局变量全部可读。
- 两个哨兵值（`0xFFFFFFFF`、`0xFFFFFFFE`）都表示**类型名内联**；`typeRef` 归一化为 `-1`，
  GUID 通过 `guid` 字段暴露。

验证（`test/parse-decl.js`，与 `.asc` 的 `VAR…END_VAR` 块对照）：

| 指标 | 结果 |
|---|---|
| 27 组配对工程 | 300 条显式变量，**300 条命中（100%）** |
| `EN`/`ENO` | 60 条不计（FUNCTION 的隐式接口，`.pro` 不存储） |

> 已知限制：27 组样本里**所有**声明记录的 `typeRef` 都是 `-1`（类型名内联），因此
> `typeRef != -1` 的自定义类型解析路径没有样本可验证，代码保留 `typeRef` 字段但未使用。

### 5.4 DUT 字段记录（`TYPE … END_TYPE`）

DUT 是对象类型码 **`0x0C`**，**没有子对象**；字段以内容帧直接挂在 DUT 对象自己的 id 下：

- 每个字段一条 **kind 4（二进制）** 内容帧，布局与 §5.3 的变量记录相同，但**没有作用域 token**
  （结构体字段不属于 `VAR…` 块）；
- DUT 还拥有一个 kind 6 帧（字段 id 列表），解析结果按帧偏移排序即为声明顺序；
- 空注释槽同样可能出现（本次 84 条字段记录全部带一个 `u32 0` 空槽）。

```
09 00 00 00 "Int1"  ff ff ff ff  00 00  00 00 00 00  03 00 00 00 "INT"  01 00 00 00 "0"
```

验证（`test/parse-dut.js`，与 `.asc` 的 `TYPE` 块对照）：**12/12 个 DUT、84/84 个字段**
（名称 / 类型 / 初值）全部一致，覆盖 9 个含 DUT 的样本。数组/结构体类型名（如
`ARRAY [0..2] OF REAL`、`STRING[32]`）在字段记录里也是内联字符串，直接可用。

### 5.5 全局变量表（`CONFIGURATION … VAR_GLOBAL`）

全局变量表是对象类型码 **`0x0D`**（名字 `Glob. Variablen` / `Global Variables`），
每个工程都有至少一个（模板占位）。变量记录挂在列表对象的 id 下，布局见 §5.3 补充规则：

- 作用域 token 为 `VAR_GLOBAL`；
- 地址（`AT %IX0.0` 等 FP 地址）在初值之后；
- 空列表只有 1 个 48~88 字节的 kind 6 头部帧，解出 0 条变量（不会误报）。

验证（`test/parse-glob.js`，与 `.asc` 的 `CONFIGURATION` 段对照）：
**99/99 条全局变量**（名称 / 类型 / 地址 / 初值）全部一致，分布在 14 个样本；
其余 13 个样本是纯占位空表（解出 0 条，不会误报）。`.asc` 里的注释带 `~A` 语言后缀，比对时忽略注释。

### 5.6 任务配置与程序绑定（`TASK ... (SINGLE, INTERVAL, PRIORITY)` + `PROGRAM X WITH <task>`）

任务文件夹是对象类型码 **`0x12`**（`Tasks`），下挂每个任务一个对象（类型码 `0x0E`）。
一个任务对象带两类内容帧：**设置帧（kind 6）** 与 **程序绑定帧（kind 4，每个已分配程序一条）**。

#### 设置帧（kind 6）

```
ff ff ff ff                          u32 哨兵 -1
05 00 00 00 "FALSE"                  SINGLE（布尔 / I0…I23 中断输入）
06 00 00 00 "T#10ms"                 INTERVAL
02 00 00 00 "31"                     PRIORITY
ff ff ff ff                          u32 哨兵 -1
02 00 00 00                          u32 已分配程序数 n
79 00 00 00 7a 00 00 00              n × u32 绑定记录 id（不是对象 id，见下）
91 00 00 00 fa 00 00 00 46 00 …     固定尾部（看门狗/编译参数一类的常量，27 组样本一致）
```

- 每个工程都会保留**完整的模板任务集 27 个**（`Programs`、`Programs 2`、`Interrupt 0…23`、
  `Timer Interrupt`），与具体有没有程序关系不大；个别工程的第一个任务名是 `Programs 1`
  （`.asc` 的 `TASK` 名同样如此，不是解析偏差）；
- `.asc` 只导出**所选 PLC 型号支持**的子集（例：FP‑X 只导出 `Interrupt 0…5`），
  因此对照断言是「`.asc` 里导出的任务都能在 `.pro` 找到且参数一致」（27 组全部满足，
  没有反向要求）；
- `n` 与随后的 u32 是**该任务每条 kind 4 绑定帧自己的记录 id**——取绑定帧帧头 `+0x12`
  （u32，压缩前的帧头，不是解压后的载荷），设置帧按**分配顺序**列出。它们**不是对象 id，
  也不是“分配号”**。2026-11-17 对 42 个容器、1134 个带 kind 4 帧的任务对象全扫
  （`work/progids5.js`）：
  - **34 个任务**：设置帧 id 列表与绑定帧 `+0x12` 列表**顺序完全一致**
    （含 7.7.4.0 的 `客户甲一体机临时.pro`，见下）；
  - **4 个任务**：同一集合、顺序不同（已诊断 Coffee 一例，见下）；
  - **2 个工程**：id 列表里各含 2 个 **dangling id**（1576、1643），对应的绑定记录已不存在
    （删除过分配）。`4.06.722.25(上板机).pro` 与 `4.12.702.25(上板机)_V04.pro` 两个工程
    的其余 id 仍然顺序一致。

- **帧顺序 ≠ 分配顺序**。Coffee machine 的设置帧是 `[121, 122]` → `count_coins, coffee`，
  而文件里的 kind 4 帧顺序是 `coffee, count_coins`——按 PROGRAM 对象 id 排（coffee = `0xf0` = 240
  < count_coins = `0x105` = 261）。要还原分配顺序只能读设置帧的 id 列表。
- 两个 **id 空间**（对象表 SCOBJ 与内容记录表）的数值会碰撞，但不是同一个计数器：大工程的
  `programIds` 已达 2304，而对象 id 计数器只有 290，证明它不可能指对象。
- 解析器原样暴露 `programIds`，并用它 join 出 `assignments: [{recordId, name|null, frameOffset|null}]`：
  找不到绑定记录的 id 收进 `danglingIds`，**记录还在但载荷被清零**（见下“空绑定”）的 id
  收进 `emptyIds`。`--tasks` 打印 `binding ids: 121=count_coins  122=coffee`，
  以及 `dangling ids` / `empty ids` / `(empty)` 标记。

#### 程序绑定帧（kind 4，每个已分配 PROGRAM 一条）

任务对象 id 下挂 kind 4 内容帧（**文件顺序按 PROGRAM 对象 id 排，不是分配顺序**），解压后：

```
0b 00 00 00                          u32 名字长度
"Program_RND"                        UTF-16LE 程序名（保留对象原大小写）
ff ff ff ff                          哨兵 -1
00 00 00 00 00 00                    6 字节 0
```

- 名字**保留 PROGRAM 对象的大小写**，可直接与 `pous()` 的名字精确匹配；
- 名字是**普通 UTF-16 文本，不是 ASCII**：7.7 工程里就有 `工位甲手动上料_CON`、`扫码程序`、
  `仪表通讯`。解析器只拒绝控制字符/DEL/孤立代理项（`readAssignmentName`）；
- kind 4 帧帧头 `+0x12` 的解压前 u32 是这条绑定记录自己的 id，设置帧的 id 列表引用的就是它；
- **7.7.x 把这两类记录写成 `FC FC` 帧**（§1.2.1），payload 布局不变；不识别该 tag 时
  整段记录不可见（详见 §1.2.1 的“为什么必须识别”）；
- Coffee machine 两条：`coffee`、`count_coins`（文件顺序按 PROGRAM 对象 id；设置帧给出的
  分配顺序是 121 = `count_coins`、122 = `coffee`，见上）。`.asc` 的行序是导出器排序，
  不要按行序配 `programIds`；
- 另有 kind 10 帧挂在任务对象下，重名但**全大写**（`PROGRAM_RND`、`ALARM_LD`…），
  可作二次证据（大小写不敏感匹配）；解析器只用 kind 4。

#### 空绑定（`emptyIds`）

分配被清空后，FPWIN 只是把记录载荷清零，**并不删帧**：

```
00 00 00 00                          u32 名字长度 = 0
ff ff ff ff                          哨兵 -1
00 00 00 00 00 00 …                  其余全 0（整条 14 字节）
```

于是同一个 id 有“记录在、但没名字”的状态。解析器把它与“记录根本不存在”区分开：

| 状态 | 判定 | 暴露字段 | 实测样本 |
|---|---|---|---|
| 记录存在且有名字 | `readAssignmentName` 成功 | `assignments[].name` | 42 容器共 75 条，**75/75 命中同名 PROGRAM 对象** |
| 记录存在但载荷清零 | 有 kind 4 帧、解压后名字长度 0 且随后是哨兵 | `emptyIds` | 客户甲 2303/2304、工程乙 1469、下料 2008、设备三 1031 |
| 记录不存在 | 设置帧列了 id，任务对象下没有对应帧 | `danglingIds` | 4.06 / 4.12 的 1576、1643 |

7.7.4.0 的 `客户甲一体机临时.pro` 因此从“**0 个程序名**”变成 **9/11**：
`2294=IOU 2295=TESTER 2296=设备一_CON 2297=工位甲手动上料_CON 2298=设备一_ALM
2299=设备一_SOV 2300=设备一_VER 2301=扫码程序 2302=仪表通讯`，`emptyIds=[2303,2304]`。

验证：

| 指标 | 结果 |
|---|---|
| `test/parse-task.js`：任务设置 vs `.asc` `TASK` 块 | **653/653 个任务、1959/1959 项参数（100%）** |
| `test/parse-bind.js`：`PROGRAM X WITH <task>` vs `.asc` | **32/32 条绑定（27/27 工程，100%）** |
| 数量一致性：kind 4 帧数 == 设置帧 n | **27/27 工程一致**（0 不匹配） |
| 名字 ↔ PROGRAM 对象 | **75/75 命中**（42 容器；`work/bindname-check.js`） |

> 说明：`.asc` 只导出**已绑定**的 PROGRAM（例：Flasher 有 2 个 PROGRAM，只导出
> `FlasherSolution2 WITH Programs`）；未绑定的 PROGRAM 在 `.pro` 的任务对象下没有 kind 4 帧，
> 两者一致。

### 5.7 SFC 图（`SFC` POU 的二进制元素流）

SFC POU 没有 `BODY…END_BODY` 文本体，而是带一个类型 **`0x08`** 的图段（名字通常是 `Body`
或 `Rumpf`）。该段 id 下有一条 **kind 6** 内容帧，解压后是**二进制元素流**（`parseSfcChart`）。
图段下另有三个文件夹对象：

| 文件夹 | 类型码 | 内容帧（kind 6） | 含义 |
|---|---|---|---|
| `Actions` | `0x09` | `u32 个数 + 个数×u32` 动作对象 id | SFC 动作定义（每个动作一个 `0x06` 对象，正文是普通文本帧） |
| `Transitions` | `0x0A` | `u32 个数 + 个数×u32` 转移对象 id | 转移定义（正文是普通文本帧，语言 LD/IL/FBD） |
| `Steps` | `0x21` | 只有 `u32 0` | 步**不**单独建对象；样本里恒为空表 |

Coffee machine 实测：`Actions` = 4 → `[253, 255, 257, 259]`；`Transitions` = 3 → `[249, 247, 251]`；
`Steps` = 0。

#### 元素记录（以魔数开头，顺序 = 图遍历顺序）

```
+0x00 u32 0x467312AA              魔数
+0x04 u32 1                       格式/版本
+0x08 u32 1
+0x0C u16 0                       未用
+0x0E u16 seq                     元素序号（沿图遍历递增）
+0x10 u16 0                       未用
+0x12 u16 kind                    元素类型（见下表）
+0x14 u16 0                       未用
+0x16 u16 nameChars               名字长度（UTF-16 单元，含结尾 NUL；1 = 无名）
+0x18 u16 0                       未用
+0x1A     UTF-16LE name           nameChars 个单元（末尾 NUL）
```

名字之后（`p = 0x1A + nameChars*2`）按类型分派：

| kind | 元素 | 名字之后 |
|---|---|---|
| `2` | `INITIAL_STEP` | `u32 0`、`u32 1`、`u32 textChars`、`textChars` 个 UTF-16 单元的动作表 |
| `6` | `STEP` | 同上 |
| `8` | `TRANSITION` | `u32 hasBody`；`1` 时再 `u32 sectionId`（转移对象 id）、`u32 langChars`（含 NUL）、语言标签（`LD`/`IL`/`FBD`）、`u32 0`；`0` 时只有 `u32 0` |
| `1` | 图起点伪元素 | 两个 `u32 0` |
| `3` | `FINAL_STEP`（无名） | 两个 `u32 0` |
| `11` | `divergence` 发散条（无名） | 两个 `u32 0`；分支信息在连线表 |
| `12` | `convergence` 汇合条（无名） | 同上 |
| `13` | `branch-start` 分支入口（无名） | 同上 |
| `14` | `branch-end` 分支出口（无名） | 同上 |

> **更正（2026-11-17）**：STEP 后面第二个 u32 **不是动作行数**。4 个 SFC 图的全部步里它恒为 `1`，
> 与动作表行数无关：Coffee 的 `select_drink` 有 2 行动作、`lay_the_table`/`wait_heat_oven` 有 0 行，
> 该字段都是 `1`。解析器仍以 `actionCount` 暴露原值，但语义未定（更像「有动作表」标志位）。

动作表文本：每行一个 `动作名 [TAB 限定符]`，行尾 `CRLF`，最后一行后还有 `TAB`/`CRLF` 和
结尾 NUL；解析时清掉 NUL、按行拆成 `{name, qualifier}`。动作名分两类：

- 命中 `Actions` 文件夹里的动作对象 → `sectionName` 为对象名，`body` 是动作对象的文本帧；
- 未命中（例如 Coffee 的 `green_light`）→ 是**全局变量/布尔动作**，没有动作对象、没有正文。

转移/动作正文都是各自对象 id 下的普通 zlib+UTF-16LE 文本帧（同 §5），语言由正文里的
`NETWORK_LIST_TYPE := NWTYPELD/IL/FBD` 标记得出。

#### 前导区 = 连线表（FROM/TO 就存放在这里）

第一条元素记录前是**连线表**：15 个 u32 头 + `N` 条 ×20 字节记录（`parseSfcTable`）。

```
+0x00..+0x38  15×u32 头
  word0  = 0
  word1  = 流对象 id（Coffee 245 = Transitions 文件夹；无该文件夹时是 A_STREAM id）
  word2  = 5200 (0x1450)            固定魔数
  word3  = 4                        固定
  word4  = N                        记录条数
  word7 / word8                     Actions / A_STREAM 对象 id（无则 0）
  word11 = 2
+0x3C 起  N×20 字节记录（第 k 条属于元素 id = k + 2）
  +0x00 u32 prev                    上一条（0 = 无）
  +0x04 u32 next                    下一条（0 = 无）
  +0x08 u32 c                       分支辅助字段（含义随 kind 变化）
  +0x0C u32 d                       分支辅助字段（含义随 kind 变化）
  +0x10 u32 token                   每条不同（0x07E4****/0x0*******），非连线数据
```

- 元素 **id** 与元素记录里的 `seq` 是同一个编号空间：`seq` 就是 id。表中第 k 条记录
  对应 **id = k + 2**，因为 id 1、2 是图根/起点伪结点（id 3 才是 kind 1 的图起点元素）。
- **删除过的元素留下 `4 × 0xFFFFFFFF` 哨兵**（4 个样本都在 k=2、3，即 id 4、5，疑似模板工程
  删掉的两个元素），解析时跳过。
- 表的最后一条是终止记录 `(2, 1, 2, 42)`，不是元素行。

四个连线字段按 kind 解释（`entries`/`ends` 两条链就是分支的顺序）：

| kind | 元素 | prev | next | c | d |
|---|---|---|---|---|---|
| 2 / 6 | 步 | 前驱元素 | 后继元素 | 0 | 0 |
| 8 | 转移 | 源步或分支入口 | 目标步或分支条 | 0 | 0 |
| `11` | `divergence`（发散条） | 分叉前的元素 | 0 | **第一个分支入口（entries 链头）** | 0 |
| `13` | `branch-start`（分支入口） | 0 | 该分支的首个元素 | **下一个入口** | **上一个入口（首个入口的 d = 发散条）** |
| `14` | `branch-end`（分支出口） | 该分支的最后一个元素 | 0 | **上一个出口** | **下一个出口** |
| `12` | `convergence`（汇合条） | 0 | 汇合后的元素 | 0 | **第一个出口（ends 链头）** |

**还原 FROM/TO 的算法**（`sfcWiringResolvers`，库里的 `back()`/`fwd()`）：

- `fwd(id)`：kind 11 → 逐个入口 `fwd(入口.next)`；kind 13 → `fwd(next)`；kind 14 → 找到它所属的
  汇合条（沿 `c` 链找 kind 12）再 `fwd(条.next)`；kind 12 → `fwd(next)`；其余 → `[id]`。
- `back(id)`：kind 13 → 发散条（沿 `d` 链找 kind 11）的 `prev` 再 `back()`；kind 12 → 对 `ends`
  链上每个出口的 `prev` 各 `back()` 一次（并行分支 → 多源）；kind 11/14 → 各自 `prev`/汇合条
  `next` 再回溯；kind 3（图起点/终止步）→ 空。
- 于是转移的 `from = back(prev)`、`to = fwd(next)`，天然支持**并行分支多源多目标**
  （Pizza 的 `TRANSITION #53#recipe_found ... TO (#56#Heat_oven,#59#get_tablecloth,#64#get_utensils)`
  与 `TRANSITION #97#oven_reach_temp FROM (...)`）。

> **顺序**：`.asc` 的 `TO (...)` 顺序 = 入口链顺序；`FROM (...)` 顺序 = 出口链的**逆序**
> （Pizza `oven_reach_temp` 出口链是 24,16,8，`.asc` 写作 `#56#,#61#,#94#` = 8,16,24），
> 比对时按集合。

#### 流末尾 22 字节收尾块（trailer）

元素记录之后、同一条 kind 6 帧的最后 22 字节是一条**图表收尾块**（`parseSfcTrailer`）。
它不是元素记录（长度不够），布局如下（5/5 个图段实例全部吻合）：

| 偏移 | 类型 | 值 / 含义 |
|---|---|---|
| `+0x00` | u32 | `0x467312AA`，与元素记录同一个魔数 |
| `+0x04` | u32 | `1`，格式/版本（同元素记录） |
| `+0x08` | u32 | `1` |
| `+0x0C` | 6 字节 | 全 `0`（元素记录此处是 seq / kind / 名字长度，这里恒为 0） |
| `+0x12` | u32 | 该图 **Steps 文件夹对象 id**（类型 `0x21`，图段子对象 `Steps` / `Schritte`） |

验证（`work/sfc-tail3.js`）：4 个 SFC 图（含夹具副本共 **5 个图段**）的末 4 字节分别为
**218 / 225 / 246 / 224**，全部等于各自图的 Steps 文件夹 id；6 个零字节恒成立。
解析器在 `sfcCharts()` 里输出 `trailer`、`stepsFolder`、`stepsFolderId`、`trailerVerified`。

> **遗留限制**：该字段按 u32 读，但样本值都 < 65536，无法区分 u32 与 u16+u16；不影响当前解析。

#### 验证

| 指标 | 结果 |
|---|---|
| `test/parse-sfc.js`：SFC 图 vs `.asc` `SFC *` 段 | **4/4 图完全一致** |
| 步 / 动作 / 转移 | **28/28 步、41/41 动作、29/29 转移** |
| 转移语言 / 转移正文 / 动作正文 | **22/22 语言、22/22 正文、26/26 动作正文**（其中 1 条转移正文仅结构一致） |
| **FROM/TO 连线** | **58/58（29 个转移 × FROM+TO）全部一致**，含 3 路并行发散/汇合 |

`.asc` 的元素顺序是导出器按图遍历重排的，和 `.pro` 的 marker 顺序不一定相同，比对时按多重集。

## 6. 健壮性：假帧与二次扫描

数据块里可能出现恰好等于 `FA FA` 的字节，造成线性帧链**错位**（帧长度越界）。
现象：后续对象整段丢失（例如 `Coffee machine (SFC).pro` 的 `count_coins`）。

解析器处理方式（三层）：

1. **线性帧链**：正常路径；遇到 `len` 越界时丢掉 1 字节继续找下一个 tag，而不是中止。
2. **`FE FE` 假帧过滤**（2026-11-17 新增）：`FE FE` 字节对也会出现在压缩数据里，若照单全收会把
   帧链带偏。真页帧的 `+0x06` 只有两种取值——`9`（空页）或 `len−22`（满页），据此过滤。
   效果（9 个 1.1–3.1 MiB 工程）：页帧从 29–41 个降到 18 个，内容帧恢复量 +124 … +596，
   `recoveredByScan` 从 35/52 降到 11/48，`0 warning` 不变。
3. **独立二次扫描**：在 `[0x800, usedLength)` 逐字节找 `FA FA`，用对象记录的严格校验
   （`+0x04==0`、`+0x0A==2`、`+0x2A..2C` 为零、名字长度不越界、名字全可打印）单独确认，
   已线性走过的偏移跳过。这样即使帧链错位也能把对象捞回来（记录标记 `recoveredByScan`）。

---

## 7. 验证结果

| 验证项 | 结果 |
|---|---|
| `D:\FP7752\Samples\English` 27 组 `.pro`/`.asc` 对象名对照 | **27/27 通过**（每个 `.asc` 声明的 PROGRAM/FUNCTION_BLOCK/FUNCTION 都能在 `.pro` 里找到同名对象） |
| POU 类型码归因（`tools/typecensus.js`） | 71 PROGRAM→`0x0F`、22 FB→`0x10`、22 FUNCTION→`0x11`，**0 未解析** |
| 记录时间戳归因（`+0x1E`） | **5617/5617** 条记录落在 2005–2030 Unix 秒；根对象恒为工程最后保存时间（26 组样本共享模板时间 2008-09-29T15:08:53，Coffee 2011-10，EmptyPrj 2020-06-08），1 条为 0 |
| 容器长度字段（`u32@0`） | **43/43** 个容器 `u32@0 == size − 1`（65536 B … 3244032 B） |
| SC 表目录（`work/tables-verify2.js`） | 42/42 个容器各 **10 条 401 字节表记录**（40 个完整 + 2 个省略空 `SCDECL_TAB.dat`）；`.dat` 追加偏移 41/42 等于最后一个对象记录偏移、id 计数器 41/42 等于最大对象 id（或 +1）；表时间最大值 **42/42** 等于根对象 mtime；**`.idx` 页 42/42 为空** |
| 7.7.x 声明方言 | 一个 7.7.4.0 工程 **1589/1589** 条记录恰好消费完内容帧（0 残留）；该工程声明从 0 → **2084** 条可读 |
| `typeRef` 归因 | **9592** 条声明/字段（42 个容器，6.00/7.5/7.7 三种方言）**全部内联类型名**，无 UDT id 样本 |
| 大工程 / 多块容器（`work/multi.js`） | **42** 个容器（含 **6** 个 1.1–3.2 MiB 客户工程；最长 **1570 页 / 3000 帧**）全部解析、**0 warning**；跨 `0x800` 帧最多 **225** 个，内容帧最多 **2445** 个；`0x10000` 边界无标记字节 |
| `FE FE` 假帧过滤（`work/pageframes-base.js`） | 大工程页帧 29–41 → **18**；内容帧恢复量 **+124 … +596**；`recoveredByScan` 35/52 → 11/48；夹具断言 71 项全过 |
| 页帧总量（`work/global-census2.js`） | 42 个容器共 **758** 个真页帧：41 个容器恰 18 帧，1 个（7.5→7.7 升级）20 帧（多 1 条版本记录 + 1 个 140 字节页） |
| 程序体源码对照（`test/parse-source.js`） | **79/79 通过**（63 逐字节 + 16 结构一致；4 个 SFC 图无文本体） |
| 变量声明对照（`test/parse-decl.js`） | **300/300 通过（100%）**；60 条 `EN`/`ENO` 为隐式接口不计 |
| DUT 字段对照（`test/parse-dut.js`） | **12/12 个 DUT、84/84 个字段通过（100%）** |
| 全局变量对照（`test/parse-glob.js`） | **99/99 条通过（100%）**，含 14 个非空表 |
| 任务配置对照（`test/parse-task.js`） | **653/653 个任务、1959/1959 项参数通过（100%）** |
| 程序↔任务绑定对照（`test/parse-bind.js`） | **32/32 条 `PROGRAM X WITH <task>` 通过（27/27 工程，100%）**；kind 4 帧数 == 设置帧 n（27/27） |
| `programIds` 归因（`work/progids5.js`） | 42 个容器、1134 个带 kind 4 帧的任务：**34 个顺序完全一致 / 4 个同集合顺序不同 / 2 个工程各含 2 个 dangling id**（1576、1643）；Coffee `[121,122]` → `count_coins, coffee` |
| `FC FC` 帧（`work/fcfc-diff.js`） | 42 个容器逐项对比：**31 个完全不变 / 11 个只增不减**（客户甲记录 2920 → 5036、内容帧 2571 → 4686、程序名 0 → 9；对象数全部不变）；**0 报错、0 名字丢失** |
| 绑定名 ↔ PROGRAM 对象（`work/bindname-check.js`） | 42 个容器 **75/75** 条解析出的绑定名都命中同名 PROGRAM 对象（其中 9 条为 CJK 名），悬空 id 10 条单独归类 |
| zlib 起点按 kind 固定（`work/zlibstart-diff.js`） | 42 个容器 **24633** 条内容帧不变、**+8** 条新增、**0** 条被改、**0** 条丢失；连带多解出 5 条变量声明（`work/zlibstart2.js`） |
| SFC 尾记录（`work/sfc-tail3.js`） | **5/5 图段 `trailerVerified=true`**，`stepsFolderId = 218/225/246/224`，6 个零字节恒成立 |
| SFC 图对照（`test/parse-sfc.js`） | **4/4 图、28/28 步、41/41 动作、29/29 转移、22/22 转移语言、22/22 转移正文、26/26 动作正文、58/58 FROM/TO 连线通过** |
| 本地夹具回归（`test/proparse.test.js`） | **71 项断言全过**（容器头、长度字段、表目录、树连通性、`.asc` 交集、类型码、源码、声明、SFC 元素/动作/转移/连线/尾记录、DUT、全局变量、任务、绑定、`FC FC` 帧、UTF-16 绑定名、`emptyIds`） |
| 解析覆盖审计（`work/coverage-audit.js`，42 个容器） | **0 解析报错 / 0 warning**；**36/42 满分**；帧 **35574**、对象 **8235**、声明 **9239**、DUT **20** 个/**95** 字段、全局变量 **43** 表/**3268** 条、任务 **1134**；POU 文本源码 **103/176**（6.00 方言 **101/106**，其中 5 个是 SFC 图；7.5/7.7 方言 **2/70**）；任务绑定名 **75/85**（`danglingIds` 4、`emptyIds` 6）；SFC **15** 图/**2962** 元素（6.00 的 5 图 106 元素、34 转移 **34/34** 连通；7.5/7.7 的 10 图只解出 2856 个 `kind=0` 记录） |

复现：

```powershell
$node = 'C:\path\to\node.exe'
$root = 'C:\work\fpwin-mcp'

& $node "$root\test\proparse.test.js"                          # 夹具回归
& $node "$root\test\parse-pro.js" 'D:\FP7752\Samples\English'  # 27 组对象名对照
& $node "$root\test\parse-source.js" 'D:\FP7752\Samples\English'  # 27 组源码对照
& $node "$root\test\parse-decl.js" 'D:\FP7752\Samples\English'  # 27 组变量声明对照
& $node "$root\test\parse-dut.js" 'D:\FP7752\Samples\English'   # 27 组 DUT 字段对照
& $node "$root\test\parse-glob.js" 'D:\FP7752\Samples\English'  # 27 组全局变量对照
& $node "$root\test\parse-task.js" 'D:\FP7752\Samples\English'  # 27 组任务配置对照
& $node "$root\test\parse-bind.js" 'D:\FP7752\Samples\English'  # 27 组 PROGRAM X WITH 绑定对照
& $node "$root\test\parse-sfc.js" 'D:\FP7752\Samples\English'   # 27 组 SFC 图对照
& $node "$root\tools\typecensus.js" 'D:\FP7752\Samples\English'# 类型码归因
& $node "$root\work\mtime-probe.js"                             # 记录时间戳归因（+0x1E）
& $node "$root\work\magic-check.js"                             # 容器长度字段 == size-1
& $node "$root\work\tables-verify2.js"                          # SC 表目录不变量
& $node "$root\work\multi.js"                                   # 大工程 / 多块容器
& $node "$root\work\global-census2.js"                          # 42 个容器的页帧形状
& $node "$root\work\pageframes-base.js"                         # 大工程页帧/内容帧恢复量
& $node "$root\work\progids5.js"                                # programIds == 绑定记录 id 归因
& $node "$root\work\fcfc-diff.js"                               # FC FC 帧前后对比（31 不变 / 11 只增）
& $node "$root\work\bindname-check.js"                          # 绑定名 ↔ PROGRAM 对象
& $node "$root\work\zlibstart-diff.js"                          # zlib 起点改动：0 改 / 0 丢
& $node "$root\work\sfc-tail3.js"                               # SFC 22 字节尾记录归因
& $node "$root\work\coverage-audit.js"                          # 42 个容器解码覆盖审计 → work/coverage-audit.txt
```

---

## 8. 配套工具

| 文件 | 作用 |
|---|---|
| [lib/proparse.js](lib/proparse.js) | 解析核心（零依赖）：`parseProject(buf)`、`walk()`、`pous()`、`byType()`、`findByName()`、`tables(buf, project)`（§2.3 表目录） |
| [proparse-cli.js](proparse-cli.js) | 独立 CLI，不依赖 MCP：打印对象树 / POU 列表 / JSON / 与 `.asc` 对照；`--tasks` 打印 `binding ids: 121=count_coins  122=coffee`、`dangling ids`、`empty ids` 与 `(empty)` 标记，`--sfc` 打印 22 字节 trailer（`marker/bytes/stepsFolderId/verified`），`--json` 的 `tasks[]`/`sfc[]` 与 MCP 同构 |
| `server.js` 的 `fpwin_pro_parse` | MCP 工具，返回计数、POU 列表、对象树与告警 |
| [test/proparse.test.js](test/proparse.test.js) | 夹具断言（71 项） |
| [test/parse-pro.js](test/parse-pro.js) | 批量 `.pro`/`.asc` 对象名对照 |
| [test/parse-source.js](test/parse-source.js) | 批量 `.pro`/`.asc` 程序体源码对照 |
| [test/parse-decl.js](test/parse-decl.js) | 批量 `.pro`/`.asc` 变量声明对照（名称/作用域/覆盖率） |
| [test/parse-dut.js](test/parse-dut.js) | 批量 `.pro`/`.asc` DUT 字段对照（名称/类型/初值） |
| [test/parse-glob.js](test/parse-glob.js) | 批量 `.pro`/`.asc` 全局变量对照（名称/类型/地址/初值 + 记录解码单测） |
| [test/parse-task.js](test/parse-task.js) | 批量 `.pro`/`.asc` 任务配置对照（SINGLE/INTERVAL/PRIORITY） |
| [test/parse-bind.js](test/parse-bind.js) | 批量 `.pro`/`.asc` 程序↔任务绑定对照（`PROGRAM X WITH <task>`） |
| [test/parse-sfc.js](test/parse-sfc.js) | 批量 `.pro`/`.asc` SFC 图对照（步/动作/转移/语言/正文/FROM-TO 连线） |
| [tools/prorec.js](tools/prorec.js) | 帧链遍历（调试） |
| [tools/problocks.js](tools/problocks.js) | 0x800 块映射 |
| [tools/objhdr.js](tools/objhdr.js) | 对象头长度/类型统计 |
| [tools/zmap.js](tools/zmap.js) | 扫描所有 zlib 内容帧并按所有者归类 |
| [tools/zextract.js](tools/zextract.js) | 解压全部内容帧，标注 owner/文本/二进制 |
| [tools/symtab.js](tools/symtab.js) | 符号表内容解压与字符串清单 |
| [tools/bodydbg.js](tools/bodydbg.js) | 单个 POU 的段/内容帧明细 |
| [tools/decl.js](tools/decl.js) | 变量声明记录解码原型（逐 POU 打印作用域/名字/类型/初值） |
| [tools/dutdump.js](tools/dutdump.js) | DUT 对象：内容帧、字段记录与字段名全局搜索 |
| [tools/globall.js](tools/globall.js) | 全工程全局变量表逐条打印（含帧清单） |
| [tools/taskdump.js](tools/taskdump.js) | 任务对象：内容帧、参数串与绑定 id 解析 |
| [tools/hexfind.js](tools/hexfind.js) | 按 UTF-16 串定位内容帧并 hex 转储 |
| [tools/hexwin.js](tools/hexwin.js) | 任意偏移 hex/ASCII/UTF-16 窗口 |
| [tools/typecensus.js](tools/typecensus.js) | `.asc` 归因类型码 |
| [tools/missdiag.js](tools/missdiag.js) | 对照缺失项诊断 |

CLI 用法：

```powershell
node proparse-cli.js 工程.pro                 # 摘要 + 对象树
node proparse-cli.js 工程.pro --pous          # 只列 POU
node proparse-cli.js 工程.pro --json --out out.json
node proparse-cli.js 工程.pro --asc 工程.asc  # 与导出对照，缺失项非零退出
node proparse-cli.js 工程.pro --records       # 调试：逐帧列表
node proparse-cli.js 工程.pro --sfc           # SFC 图：元素/动作/转移语言/FROM-TO
node proparse-cli.js 工程.pro --tables        # SC 表目录：.dat/.idx 记录、页偏移、id 计数器、表时间
node proparse-cli.js 工程.pro --json          # 全量 JSON（含 counts.sfcCharts、sfc 元素与 wiring、tables）
```

---

## 9. 已知未知（下一步）

> 逐项能力矩阵（状态 / 证据 / 剩余边界）见 **§10**；本节只列剩余未知项。

1. **已解**：变量声明/DUT/全局变量/任务参数/程序绑定（§5.3–§5.6）、
   `programIds` 与 SFC 22 字节尾记录（§5.6、§5.7）、
   `+0x1E` 修改时间（§2）、`FE FE` 表目录与假帧过滤（§1.2、§6）、SC 表目录 `.dat`/`.idx`（§2.3）、
   容器长度字段与大工程（§1.1）、7.7.x 声明方言（§5.3）、
   **7.7.x 的任务程序名**（`FC FC` 帧 §1.2.1 + UTF-16 名字 + `emptyIds` §5.6；7.7 样本 9/11 命中）。
   - 剩余边界：4 个任务的 `programIds` 与绑定帧**同集合、顺序不同**，目前只诊断了 Coffee 一例；
     另有 2 个工程各含 2 个 dangling id（1576、1643），只能确认“记录不存在”，
     无法还原它们当初指向哪个 PROGRAM。
2. **`.idx` 索引项格式**：42/42 个容器的 `.idx` 页都是 `0xFF` 保留页，**磁盘上不存在非空索引样本**
   ——FPWIN 只写 `.dat` 侧，索引在打开/编译时重建。要解它需要一份「带索引」的工程文件。
3. **`typeRef` 的 UDT id 编码**：9592 条声明/字段里 `typeRef` 只有两个哨兵值
   （`0xFFFFFFFF` 6.00/7.5、`0xFFFFFFFE` 7.7+GUID），自定义类型（含 `ARRAY … OF 坐标`）也是
   **内联类型名**。因此“`typeRef != -1`”在当前样本族里根本不会出现；真有 UDT id 时的编码未验证。
4. **内容帧与段的完整映射**：目前按内容（`BODY` 前缀）与 owner id 归段；段间的完整链
   （`prev`）与多帧拼接顺序在极端工程上可能还有边界情况。
5. **SFC 主图**：元素/动作/转移体/连线/尾记录**全部已解**（§5.7；4/4 图、58/58 FROM/TO 全绿）。
   剩余边界：22 字节尾记录末字段按 u32 读，样本值都 < 65536，无法区分 u32 与 u16+u16。
   剩余细节：连线表每行第 5 个 u32（`token`，0x07E4**** 等）含义未定，疑似编辑期分配的句柄/时间戳。
6. **`+0x26..+0x28` 属性字节**语义未定（怀疑是标志位与子类型）。
7. **表描述符 `+0x18` / `+0x1C`**：`+0x18` 在 `.idx` 记录里像个 id 上界、在 `.dat` 里多为 0；
   `+0x1C` 是表码但随版本变化（6.00 的 `0x15812` vs 7.5/7.7 的 `0xC812`），字段切分未定。
8. **类型码 `0x3x/0x6x`** 的 PLC 配置条目未细分命名。
9. 容器上限未测：本机最大样本 3244032 B（1584 页）；更大的工程（若 `u32@0` 以 64 KiB
   块形式回绕）需要再取样。
10. **7.5/7.7 内容层方言（2026-11-17 覆盖审计新发现，本轮未修）**：
    - **POU 本体段**（section type `0x1A`）的内容帧是 `u32 字符数 + UTF-16LE 文本`，
      没有 6.00 的 `BODY…END_BODY` 包装。`pouSource()` 只认 `BODY` 前缀，于是 7 个
      7.5/7.7 容器（`EmptyPrj.pro`、`客户甲一体机临时.pro` 和 5 个大客户工程）的
      **70 个 POU 里只有 2 个**能出源码；
      解压数据首 4 字节就是字符数（例：`5e 05 00 00` → 1374 字符，后接 `CRLF`）。
    - **SFC 图段**（section type `0x08`）虽然也含 `0x467312AA` 标记，但元素记录步长/字段与 6.00
      不同，`parseSfcChart()` 在这 10 个图上解出 **2856 个 `kind=0` 记录、0 个有效元素**。
    - 这两项不影响容器/对象/声明/全局变量/任务的解析（未满分的 6 个容器在这些层都是满的），
      只影响“把内容读出来”的覆盖率，因此 `work/coverage-audit.js` 把它们列为非满分。

---

## 10. 解析覆盖范围（能力矩阵）

**总述：结构层（容器头、帧链、对象树、段与内容帧归属）已全覆盖；6.00 方言的内容层已解；
7.5/7.7 的两处内容层方言（POU 本体文本、SFC 元素流）仍未解；另有少量字段语义因缺样本未定。**
下面不是“全部字段已知”，每项都给出证据章节和仍然存在的边界。硬数字来自
[work/coverage-audit.js](work/coverage-audit.js) 对本机 **42 个可得容器**的全量审计
（结果落盘 [work/coverage-audit.txt](work/coverage-audit.txt)）：**0 解析报错、0 warning、36/42 满分**。

| 能力 | 状态 | 证据（§） | 剩余边界 |
|---|---|---|---|
| 容器头 / `u32@0 == size−1` / 0x800 页对齐 | 已解 | §1.1 | 上限未测（本机最大 3244032 B） |
| 帧链 `FA FA` / `FE FE` / `FC FC`、假帧过滤与二次扫描 | 已解 | §1.2、§1.2.1、§6 | — |
| 对象记录 / 对象树 / 类型码 | 已解 | §2、§3、§4 | `+0x26..+0x28` 属性字节、`0x3x/0x6x` 未细分命名 |
| POU 源码（文本体） | 部分 | §5、§5.1、§5.2 | 6.00 方言 **101/106**（其余 5 个是 SFC 图，无文本体属正常）；**7.5/7.7 本体段是 `u32 字符数 + UTF-16`，7 个容器 70 个 POU 只有 2 个出源码** |
| 变量声明 `Kopf` / `Header` | 已解 | §5.3 | `typeRef` 的 UDT id 编码无样本 |
| DUT 字段（`TYPE … END_TYPE`） | 已解 | §5.4 | 同上 |
| 全局变量表（`VAR_GLOBAL`） | 已解 | §5.5 | — |
| 任务配置（SINGLE / INTERVAL / PRIORITY） | 已解 | §5.6 | — |
| 程序↔任务绑定（`PROGRAM X WITH`） | 部分 | §5.6、§1.2.1 | 绑定名 **75/85**；`danglingIds` 4 个、`emptyIds` 6 个；4 个任务的 id 集合相同但顺序不同（只诊断 Coffee 一例） |
| SFC 图（元素 / 动作 / 转移 / 连线 / 尾记录） | 部分 | §5.7 | 6.00 的 5 图 106 元素、34 转移 **34/34** 连通；**7.5/7.7 的 10 图只解出 2856 个 `kind=0` 记录、0 个有效元素**；尾记录末字段 u32 vs u16+u16、连线表 `token` 未定 |
| SC 表目录（`.dat` / `.idx`） | 部分 | §2.3 | `.idx` 42/42 为空、磁盘无非空样本；描述符 `+0x18/+0x1C` 切分未定 |
| 表描述符 `+0x18/+0x1C`、对象属性 `+0x26..+0x28` | 未知 | §2、§2.3 | 字段切分与语义未定，无对照样本 |
| 记录时间戳（`+0x1E`） | 已解 | §2 | 1 条记录为 0 |
| 大工程 / 多块容器 | 已解 | §1.1、§6、§7 | 42 个容器 0 报错、0 warning；最大 3244032 B / 3018 帧 |

**审计汇总**：帧 35574、对象 8235、声明 9239、DUT 20 个/95 字段、全局变量 43 表/3268 条、
任务 1134、绑定名 75/85、SFC 15 图/2962 元素。**满分容器 36/42**；6 个非满分全是 7.5/7.7
容器，缺口只有上表“POU 源码”和“SFC 图”两行。逐容器的明细（对象数、POU 源码、声明、
DUT、全局、任务绑定、SFC、`danglingIds`/`emptyIds`、差距原因）在
[work/coverage-audit.txt](work/coverage-audit.txt)。

> CLI 侧对应能力：`proparse-cli.js --coverage` 打印单个工程的上述覆盖率，`--json` 顶层
> `coverage` 对象给出同样数据；两者都只调用已有返回值，不做新的解析。
