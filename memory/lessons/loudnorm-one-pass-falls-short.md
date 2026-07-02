# ワンパスの loudnorm は目標ラウドネスに届かない(音量処理は必ず実測で検証)

-30 LUFS の収録を loudnorm ワンパスで -14 LUFS に正規化しようとしたら
-16.7 LUFS までしか届かなかった。ワンパスは流しながら測って調整する
方式のため、入力が目標から遠いほど残差が出る。

対処はツーパス:1回目に `print_format=json` で実測値を取り、2回目に
`measured_I= / measured_TP= / measured_LRA= / measured_thresh= / offset=`
として渡し `linear=true` を付ける。これで誤差0.3dBに収まった。
1回目は音声のみ処理すれば数秒で終わる(映像をデコードしない)。

教訓の本体: 音量系フィルタは「足したから効いているはず」で済ませず、
必ず `ffmpeg -af ebur128 -f null -` で出力を実測する。数秒で測れる。
