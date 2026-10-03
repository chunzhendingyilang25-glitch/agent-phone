param([ValidateSet('folder','files','executable')][string]$Kind = 'folder')
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Windows.Forms
if ($Kind -eq 'folder') {
    $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
    $dialog.Description = '选择 Agent 使用的项目目录'
    $dialog.ShowNewFolderButton = $true
    if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
        ConvertTo-Json -InputObject @($dialog.SelectedPath) -Compress
    } else { '[]' }
} else {
    $dialog = New-Object System.Windows.Forms.OpenFileDialog
    $dialog.Title = if ($Kind -eq 'executable') { '选择 Agent 程序' } else { '选择要交给 Agent 的文件' }
    $dialog.Multiselect = $Kind -ne 'executable'
    if ($Kind -eq 'executable') { $dialog.Filter = '程序文件|*.exe;*.cmd;*.bat;*.com|所有文件|*.*' }
    if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
        ConvertTo-Json -InputObject @($dialog.FileNames) -Compress
    } else { '[]' }
}
$dialog.Dispose()
