export function correctionErrorMessage(reason: unknown, isZh: boolean): string {
  const code = reason instanceof Error ? reason.message : String(reason)
  const messages: Record<string, [string, string]> = {
    'correction-revision-mismatch': ['纠错结果已变化。请关闭表单，重新打开后再保存。', 'The correction changed. Close and reopen this editor before saving.'],
    'correction-busy': ['正在检测或发布，请完成当前任务后再编辑。', 'Detection or publication is active. Finish that task before editing.'],
    'source-hash-mismatch': ['原始转录已变化，不能应用旧位置。请重新检测。', 'The original transcript changed. Run detection again before applying old locations.'],
    'source-mismatch': ['所选位置与原文不一致，请重新定位。', 'The selected location does not match the original. Locate it again.'],
    'invalid-source-range': ['请选择有效的原文位置。', 'Choose a valid location in the original transcript.'],
    'invalid-unicode-boundary': ['选区切开了一个完整字符或表情，请重新选择。', 'The selection splits a complete character or emoji. Select it again.'],
    'invalid-replace': ['修改内容不能为空或与原文相同。留空可删除所选原文。', 'Replacement must differ from the original. Leave it empty to delete the selected text.'],
    'invalid-insert': ['插入内容不能为空，请指定原文中的插入位置。', 'Insertion needs nonempty text and an explicit location in the original.'],
    'invalid-delete': ['删除操作必须选择非空原文。', 'Deletion needs a nonempty original selection.'],
    'patch-text-limit': ['单项文本超过安全长度限制，请缩小修改范围。', 'This edit exceeds the text-length limit. Reduce its scope.'],
    'patch-count-limit': ['同一分片的修改项超过安全数量限制。', 'The number of edits in this shard exceeds the safety limit.'],
    'cumulative-edit-ratio-limit': ['累计修改比例超过安全限制，请缩小本次修改或撤销部分修改。', 'The total edit ratio exceeds the safety limit. Reduce this edit or revert some edits.'],
    'net-length-change-ratio-limit': ['整体长度变化超过安全限制，请减少插入或删除内容。', 'The total length change exceeds the safety limit. Reduce insertions or deletions.'],
    'patch-conflict': ['此修改与其他有效项重叠，不能直接应用。', 'This edit overlaps another active edit and cannot be applied directly.'],
    'anchor-not-unique': ['原文中有多个匹配位置，需要人工选定。', 'Several original locations match. Choose one manually.'],
    'anchor-not-found-or-outside-core': ['模型提供的上下文无法可靠定位，需要人工指定位置。', 'The model context cannot be reliably located. Choose a location manually.'],
    'missing-anchor': ['模型没有提供定位上下文，需要人工指定位置。', 'The model supplied no location context. Choose a location manually.'],
    'missing-old-text': ['模型未提供待修改原文，需要人工指定位置。', 'The model supplied no original text. Choose a location manually.'],
    'empty-operation': ['修改内容与原文相同。', 'The replacement is identical to the original.'],
    'rejected-patch-already-recovered': ['此拒绝项已关联人工修正，请编辑关联项。', 'This rejection already has a manual correction. Edit the linked item.'],
    'rejected-patch-requires-manual-recovery': ['被拒绝的模型意图不能直接应用，请先指定原文位置。', 'A rejected model intent cannot be applied directly. Locate it in the original first.'],
  }
  return messages[code]?.[isZh ? 0 : 1] || code
}
