<script setup lang="ts">
import { View } from "@element-plus/icons-vue";

type ActivityStatus = "info" | "pending" | "success" | "warning" | "error";

interface ActivityRecord {
  id: string;
  time: string;
  title: string;
  detail?: string;
  target?: string;
  request?: string;
  command?: string;
  status: ActivityStatus;
}

withDefaults(
  defineProps<{
    entries: ActivityRecord[];
    maxHeight?: number | string;
  }>(),
  {
    maxHeight: undefined,
  },
);

const emit = defineEmits<{
  detail: [entry: ActivityRecord, sequence: number];
}>();

function activitySummary(entry: ActivityRecord) {
  return entry.target || entry.detail || activityStatusLabel(entry.status);
}

function activityStatusLabel(status: ActivityStatus) {
  if (status === "pending") return "处理中";
  if (status === "success") return "成功";
  if (status === "warning") return "提醒";
  if (status === "error") return "失败";
  return "信息";
}
</script>

<template>
  <el-table
    class="settings-data-table activity-record-table"
    :data="entries"
    :max-height="maxHeight"
    row-key="id"
  >
    <template #empty>
      <div class="settings-table-empty" role="status">当前暂无操作记录</div>
    </template>
    <el-table-column type="index" label="序号" width="62" align="center" />
    <el-table-column label="时间" width="96" align="center">
      <template #default="{ row }"><time>{{ row.time }}</time></template>
    </el-table-column>
    <el-table-column label="事件" min-width="180" align="center" show-overflow-tooltip>
      <template #default="{ row }">
        <strong class="settings-log-title" :class="`status-${row.status}`">{{ row.title }}</strong>
      </template>
    </el-table-column>
    <el-table-column label="详情" min-width="260" align="center">
      <template #default="{ row, $index }">
        <div class="activity-record-detail-cell">
          <span :title="activitySummary(row)">{{ activitySummary(row) }}</span>
          <el-tooltip content="查看日志详情" placement="top">
            <button type="button" class="activity-record-detail-button" :aria-label="`查看日志详情：${row.title}`" @click.stop="emit('detail', row, $index + 1)">
              <el-icon><View /></el-icon>
            </button>
          </el-tooltip>
        </div>
      </template>
    </el-table-column>
    <el-table-column label="状态" width="82" align="center">
      <template #default="{ row }">
        <span class="activity-record-status" :class="`status-${row.status}`">{{ activityStatusLabel(row.status) }}</span>
      </template>
    </el-table-column>
  </el-table>
</template>
