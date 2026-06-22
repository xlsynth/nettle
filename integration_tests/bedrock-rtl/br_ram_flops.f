// SPDX-License-Identifier: Apache-2.0

--top br_ram_flops
+define+BR_DISABLE_FINAL_CHECKS
+incdir+bedrock-rtl/macros

bedrock-rtl/pkg/br_math_pkg.sv
bedrock-rtl/misc/rtl/br_misc_unused.sv
bedrock-rtl/misc/rtl/br_misc_tieoff_zero.sv
bedrock-rtl/misc/rtl/br_misc_tieoff_one.sv
bedrock-rtl/delay/rtl/br_delay_valid.sv
bedrock-rtl/demux/rtl/br_demux_bin.sv
bedrock-rtl/enc/rtl/br_enc_bin2onehot.sv
bedrock-rtl/mux/rtl/br_mux_onehot.sv
bedrock-rtl/ram/rtl/br_ram_addr_decoder.sv
bedrock-rtl/ram/rtl/br_ram_data_rd_pipe.sv
bedrock-rtl/ram/rtl/br_ram_flops_tile.sv
bedrock-rtl/ram/rtl/br_ram_flops.sv
