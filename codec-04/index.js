function TSDemuxer() {
    var probe = function(buf) {
        var offset = 0;
        while(offset < buf.length - 3 * 188) {
            if(buf[offset] === 0x47
                && buf[offset + 188] === 0x47
                && buf[offset + 188 * 2] === 0x47) {
                return offset;
            }
            offset++;
        }
        return -1;
    };
    
    var parsePAT = function(buf, offset) {
        // parse the first PMT entry
        return (buf[offset + 10] & 0x1f) << 8 | buf[offset + 11];
    };
    
    var parsePMT = function(buf, offset) {
        var result = {
            audioPID: -1,
            videoPID: -1
        };
        // section length
        var secLen = (buf[offset + 1] & 0x0f) << 8 | buf[offset + 2];
        var offsetEnd = offset + 3 + secLen - 4;
        // program info length
        var progInfoLen = (buf[offset + 10] & 0x0f) << 8 | buf[offset + 11];
        offset += 12 + progInfoLen;
        while(offset < offsetEnd) {
            var pid = (buf[offset + 1] & 0x1f) << 8 | buf[offset + 2];
            switch(buf[offset]) {
                // ISO/IEC 13818-7 ADTS AAC (MPEG-2 lower bit-rate audio)
                case 0x0f:
                    if(result.audioPID === -1) {
                        result.audioPID = pid;
                    }
                    break;
                // HEVC
                case 0x24:
                    if(result.videoPID === -1) {
                        result.videoPID = pid;
                    }
                    break;
            }
            offset += ((buf[offset + 3] & 0x0f) << 8 | buf[offset + 4]) + 5;
        }
        return result;
    };

    var parsePES = function(list) {
        if(!list || list.length === 0) {
            return null;
        }
        var pes0 = list[0];
        // packet start code prefix
        var prefix = pes0[0] << 16 | pes0[1] << 8 | pes0[2];
        if(prefix !== 1) {
            return null;
        }
        var pts;
        var dts;
        // 7 flags
        var flags = pes0[7];
        if(flags & 0x80) {
            pts = ((pes0[9] & 0x0e) * 536870912) +
                  ((pes0[10] & 0xff) * 4194304) +
                  ((pes0[11] & 0xfe) * 16384) +
                  ((pes0[12] & 0xff) * 128) +
                  ((pes0[13] & 0xfe) >> 1);
        }
        if(flags & 0x40) {
            dts = ((pes0[14] & 0x0e) * 536870912) +
                  ((pes0[15] & 0xff) * 4194304) +
                  ((pes0[16] & 0xfe) * 16384) +
                  ((pes0[17] & 0xff) * 128) +
                  ((pes0[18] & 0xfe) >> 1);
        }
        var result = {
            pts: pts,
            dts: dts
        };
        // PES header data length
        var hdrLen = pes0[8];
        // PES packet payload
        var payload = pes0.subarray(9 + hdrLen);
        // elementary stream
        var es = payload;
        for(var i = 1; i < list.length; i++) {
            var d = new Uint8Array(es.length + list[i].length);
            d.set(es);
            d.set(list[i], es.length);
            es = d;
        }
        result.es = es;
        return result;
    };
    
    this.demux = function(buf, callback) {
        var startOffset = probe(buf);
        if(startOffset === -1) {
            return null;
        }
        var pmtPID = -1;
        var audioPID = -1;
        var videoPID = -1;
        var audioData = null;
        var videoData = null;
        var frameCount = 0;
        for(var i = startOffset; i + 188 < buf.length; i += 188) {
            // payload unit start indicator
            var pus = (buf[i + 1] & 0x40) >> 6;
            // packet id
            var pid = ((buf[i + 1] & 0x1f) << 8) + buf[i + 2];
            // adaption field control
            var afc = (buf[i + 3] & 0x30) >> 4;
            var offset;
            if(afc > 1) {
                offset = i + 5 + buf[i + 4];
                if(offset === i + 188) {
                    continue;
                }
            } else {
                offset = i + 4;
            }
            switch(pid) {
                // PAT
                case 0:
                    if(pus === 1) {
                        offset += buf[offset] + 1;
                    }
                    pmtPID = parsePAT(buf, offset);
                    break;
                // PMT
                case pmtPID:
                    if(pus === 1) {
                        offset += buf[offset] + 1;
                    }
                    var pidInfo = parsePMT(buf, offset);
                    if(pidInfo.audioPID !== -1) {
                        audioPID = pidInfo.audioPID;
                    }
                    if(pidInfo.videoPID !== -1) {
                        videoPID = pidInfo.videoPID;
                    }
                    break;
                // audio
                case audioPID:
                    if(pus === 1) {
                        if(audioData && audioData.length > 0) {
                            var result = parsePES(audioData);
                            if(result) {
                                result.type = 'audio';
                                callback(result);
                            }
                        }
                        audioData = [];
                    }
                    if(audioData) {
                        audioData.push(buf.subarray(offset, i + 188));
                    }
                    break;
                // video
                case videoPID:
                    if(pus === 1) {
                        if(videoData && videoData.length > 0) {
                            var result = parsePES(videoData);
                            if(result) {
                                result.type = 'video';
                                callback(result);
                                frameCount++;
                            }
                        }
                        videoData = [];
                    }
                    if(videoData) {
                        videoData.push(buf.subarray(offset, i + 188));
                    }
                    break;
            }
        }
        if(audioData && audioData.length > 0) {
            var result = parsePES(audioData);
            if(result) {
                result.type = 'audio';
                callback(result);
            }
        }
        if(videoData && videoData.length > 0) {
            var result = parsePES(videoData);
            if(result) {
                result.type = 'video';
                callback(result);
                frameCount++;
            }
        }
        return frameCount;
    };
}

function ADTS() {
    var SAMPLE_RATES = [
        96000, 88200, 64000, 48000, 44100, 32000, 
        24000, 22050, 16000, 12000, 11025, 8000, 7350
    ];
    
    var getHeaderLength = function(buf, offset) {
        return buf[offset + 1] & 0x01 ? 7 : 9;
    };
    
    var getFullFrameLength = function(buf, offset) {
        return (
            ((buf[offset + 3] & 0x03) << 11) 
            | (buf[offset + 4] << 3) 
            | ((buf[offset + 5] & 0xe0) >>> 5)
        );
    };
    
    var parseFrameHeader = function(buf, offset, pts, frameIndex, frameDuration) {
        var headerLength = getHeaderLength(buf, offset);
        var frameLength = getFullFrameLength(buf, offset);
        frameLength -= headerLength;
        if(frameLength > 0) {
            var stamp = pts + frameIndex * frameDuration;
            return {
                headerLength: headerLength, 
                frameLength: frameLength, 
                stamp: stamp
            };
        }
    };
    
    this.getConfig = function(buf, offset) {
        var objectType = ((buf[offset + 2] & 0xc0) >> 6) + 1;
        var samplingIndex = (buf[offset + 2] & 0x3c) >> 2;
        var channelConfig = (buf[offset + 2] & 0x01) << 2;
        channelConfig |= (buf[offset + 3] & 0xc0) >> 6;
        var config;
        var extSamplingIndex;
        var userAgent = navigator.userAgent.toLowerCase();
        if(/firefox/i.test(userAgent)) {
            if(samplingIndex >= 6) {
                objecType = 5;
                config = new Array(4);
                extSamplingIndex = samplingIndex - 3;
            } else {
                objecType = 2;
                config = new Array(2);
                extSamplingIndex = samplingIndex;
            }
        } else if(userAgent.indexOf('android') !== -1) {
            objecType = 2;
            config = new Array(2);
            extSamplingIndex = samplingIndex;
        } else {
            objecType = 5;
            config = new Array(4);
            if(samplingIndex >= 6) {
                extSamplingIndex = samplingIndex - 3;
            } else {
                if(channelConfig === 1) {
                    objecType = 2;
                    config = new Array(2);
                }
                extSamplingIndex = samplingIndex;
            }
        }
        config[0] = objectType << 3;
        config[0] |= (samplingIndex & 0x0e) >> 1;
        config[1] |= (samplingIndex & 0x01) << 7;
        config[1] |= channelConfig << 3;
        if(objectType === 5) {
            config[1] |= (extSamplingIndex & 0x0e) >> 1;
            config[2] = (extSamplingIndex & 0x01) << 7;
            config[2] |= 2 << 2;
            config[3] = 0;
        }
        return {
            config: config,
            samplerate: SAMPLE_RATES[samplingIndex],
            channelCount: channelConfig,
            codec: 'mp4a.40.' + objectType
        };
    };
    
    this.isHeader = function(buf, offset) {
        return offset + 1 < buf.length 
            && buf[offset] === 0xff 
            && (buf[offset + 1] & 0xf6) === 0xf0;
    };
    
    this.appendSample = function(track, buf, offset, pts, frameIndex) {
        var frameDuration = (1024 * 90000) / track.samplerate;
        var header = parseFrameHeader(buf, offset, pts, frameIndex, frameDuration);
        if(!header) {
            return null;
        }
        var frameLength = header.frameLength;
        var headerLength = header.headerLength;
        var stamp = header.stamp;
        var length = headerLength + frameLength;
        var missing = Math.max(0, offset + length - buf.length);
        var unit;
        if(missing) {
            unit = new Uint8Array(length - headerLength);
            unit.set(buf.subarray(offset + headerLength, buf.length), 0);
        } else {
            unit = buf.subarray(offset + headerLength, offset + length);
        }
        var sample = {
            unit: unit,
            pts: stamp
        };
        if(!missing) {
            track.samples.push(sample);
        }
        return {
            sample: sample, 
            length: length, 
            missing: missing
        };
    };
}

function FMP4() {
    var UINT32_MAX = Math.pow(2, 32) - 1;
    
    function box(type) {
        var payload = [];
        for(var i = 1; i < arguments.length; i++) {
            payload[i - 1] = arguments[i];
        }
        var size = 8;
        var i = payload.length;
        while(i--) {
            size += payload[i].byteLength;
        }
        var result = new Uint8Array(size);
        result[0] = (size >> 24) & 0xff;
        result[1] = (size >> 16) & 0xff;
        result[2] = (size >> 8) & 0xff;
        result[3] = size & 0xff;
        for(i = 0; i < 4; i++) {
            result[i + 4] = type.charCodeAt(i);
        }
        for(i = 0, size = 8; i < payload.length; i++) {
            result.set(payload[i], size);
            size += payload[i].byteLength;
        }
        return result;
    }
    
    function mvhd(timescale, duration) {
        duration *= timescale;
        var upperWordDuration = Math.floor(duration / (UINT32_MAX + 1));
        var lowerWordDuration = Math.floor(duration % (UINT32_MAX + 1));
        return box('mvhd', new Uint8Array([
            0x01,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            0x02,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            0x03,
            (timescale >> 24) & 0xff,
            (timescale >> 16) & 0xff,
            (timescale >> 8) & 0xff,
            timescale & 0xff,
            upperWordDuration >> 24,
            (upperWordDuration >> 16) & 0xff,
            (upperWordDuration >> 8) & 0xff,
            upperWordDuration & 0xff,
            lowerWordDuration >> 24,
            (lowerWordDuration >> 16) & 0xff,
            (lowerWordDuration >> 8) & 0xff,
            lowerWordDuration & 0xff,
            0x00,
            0x01,
            0x00,
            0x00,
            0x01,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            0x01,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            0x01,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            0x40,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            0xff,
            0xff,
            0xff,
            0xff, // next_track_ID
        ]));
    }
    
    function trak(track) {
        track.duration = track.duration || 0xffffffff;
        return box('trak', tkhd(track), mdia(track));
    }
    
    function tkhd(track) {
        var id = track.id;
        var duration = track.duration * track.timescale;
        var width = 0;
        var height = 0;
        var upperWordDuration = Math.floor(duration / (UINT32_MAX + 1));
        var lowerWordDuration = Math.floor(duration % (UINT32_MAX + 1));
        return box('tkhd', new Uint8Array([
            0x01,
            0x00,
            0x00,
            0x07,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            0x02,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            0x03,
            (id >> 24) & 0xff,
            (id >> 16) & 0xff,
            (id >> 8) & 0xff,
            id & 0xff,
            0x00,
            0x00,
            0x00,
            0x00,
            upperWordDuration >> 24,
            (upperWordDuration >> 16) & 0xff,
            (upperWordDuration >> 8) & 0xff,
            upperWordDuration & 0xff,
            lowerWordDuration >> 24,
            (lowerWordDuration >> 16) & 0xff,
            (lowerWordDuration >> 8) & 0xff,
            lowerWordDuration & 0xff,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            0x01,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            0x01,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            0x40,
            0x00,
            0x00,
            0x00,
            (width >> 8) & 0xff,
            width & 0xff,
            0x00,
            0x00,
            (height >> 8) & 0xff,
            height & 0xff,
            0x00,
            0x00, // height
        ]));
    }
    
    function mdia(track) {
        return box(
            'mdia', 
            mdhd(track.timescale, track.duration), 
            hdlr(track.type), 
            minf(track)
        );
    }
    
    function mdhd(timescale, duration) {
        duration *= timescale;
        var upperWordDuration = Math.floor(duration / (UINT32_MAX + 1));
        var lowerWordDuration = Math.floor(duration % (UINT32_MAX + 1));
        return box('mdhd', new Uint8Array([
            0x01,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            0x02,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            0x03,
            (timescale >> 24) & 0xff,
            (timescale >> 16) & 0xff,
            (timescale >> 8) & 0xff,
            timescale & 0xff,
            upperWordDuration >> 24,
            (upperWordDuration >> 16) & 0xff,
            (upperWordDuration >> 8) & 0xff,
            upperWordDuration & 0xff,
            lowerWordDuration >> 24,
            (lowerWordDuration >> 16) & 0xff,
            (lowerWordDuration >> 8) & 0xff,
            lowerWordDuration & 0xff,
            0x55,
            0xc4,
            0x00,
            0x00,
        ]));
    }
    
    function hdlr(type) {
        if(type === 'video') {
            return box('hdlr', new Uint8Array([
                0x00,
                0x00,
                0x00,
                0x00,
                0x00,
                0x00,
                0x00,
                0x00,
                0x76,
                0x69,
                0x64,
                0x65,
                0x00,
                0x00,
                0x00,
                0x00,
                0x00,
                0x00,
                0x00,
                0x00,
                0x00,
                0x00,
                0x00,
                0x00,
                0x56,
                0x69,
                0x64,
                0x65,
                0x6f,
                0x48,
                0x61,
                0x6e,
                0x64,
                0x6c,
                0x65,
                0x72,
                0x00, // name: 'VideoHandler'
            ]));
        } else if(type === 'audio') {
            return box('hdlr', new Uint8Array([
                0x00,
                0x00,
                0x00,
                0x00,
                0x00,
                0x00,
                0x00,
                0x00,
                0x73,
                0x6f,
                0x75,
                0x6e,
                0x00,
                0x00,
                0x00,
                0x00,
                0x00,
                0x00,
                0x00,
                0x00,
                0x00,
                0x00,
                0x00,
                0x00,
                0x53,
                0x6f,
                0x75,
                0x6e,
                0x64,
                0x48,
                0x61,
                0x6e,
                0x64,
                0x6c,
                0x65,
                0x72,
                0x00, // name: 'SoundHandler'
            ]));
        } else {
            throw new Error('fmp4: unknown type: ' + type);
        }
    }
    
    function minf(track) {
        if(track.type === 'audio') {
            return box('minf', smhd(), dinf(), stbl(track));
        } else {
            throw new Error('fmp4: unsupported track type: ' + track.type);
        }
    }
    
    function smhd() {
        return box('smhd', new Uint8Array([
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00, // reserved
        ]));
    }
    
    function dinf() {
        return box('dinf', dref());
    }
    
    function dref() {
        return box('dref', new Uint8Array([
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            0x01,
            0x00,
            0x00,
            0x00,
            0x0c,
            0x75,
            0x72,
            0x6c,
            0x20,
            0x00,
            0x00,
            0x00,
            0x01, // entry_flags
        ]));
    }
    
    function stbl(track) {
        return box(
            'stbl', 
            stsd(track), 
            stts(), 
            stsc(), 
            stsz(), 
            stco()
        );
    }
    
    function stsd(track) {
        if(track.type === 'audio') {
            var bytes = new Uint8Array([
                0x00, // version 0
                0x00,
                0x00,
                0x00, // flags
                0x00,
                0x00,
                0x00,
                0x01,
            ]); // entry_count
            if(!track.isAAC && track.codec === 'mp3') {
                return box(
                    'stsd', 
                    bytes, 
                    mp3(track)
                );
            }
            return box(
                'stsd', 
                bytes, 
                mp4a(track)
            );
        } else {
            throw new Error('fmp4: unsupported track type: ' + track.type);
        }
    }
    
    function mp3(track) {
        var samplerate = track.samplerate;
        return box(
            '.mp3',
            new Uint8Array([
                0x00,
                0x00,
                0x00, // reserved
                0x00,
                0x00,
                0x00, // reserved
                0x00,
                0x01, // data_reference_index
                0x00,
                0x00,
                0x00,
                0x00,
                0x00,
                0x00,
                0x00,
                0x00, // reserved
                0x00,
                track.channelCount, // channelcount
                0x00,
                0x10, // sampleSize:16bits
                0x00,
                0x00,
                0x00,
                0x00, // reserved2
                (samplerate >> 8) & 0xff,
                samplerate & 0xff,
                0x00,
                0x00,
            ])
        );
    }
    
    function mp4a(track) {
        var samplerate = track.samplerate;
        return box(
            'mp4a',
            new Uint8Array([
                0x00,
                0x00,
                0x00, // reserved
                0x00,
                0x00,
                0x00, // reserved
                0x00,
                0x01, // data_reference_index
                0x00,
                0x00,
                0x00,
                0x00,
                0x00,
                0x00,
                0x00,
                0x00, // reserved
                0x00,
                track.channelCount, // channelcount
                0x00,
                0x10, // sampleSize:16bits
                0x00,
                0x00,
                0x00,
                0x00, // reserved2
                (samplerate >> 8) & 0xff,
                samplerate & 0xff, //
                0x00,
                0x00,
            ]),
            esds(track)
        );
    }
    
    function esds(track) {
        var configlen = track.config.length;
        return box('esds', new Uint8Array([
            0x00, // version 0
            0x00,
            0x00,
            0x00, // flags
            0x03, // descriptor_type
            0x17 + configlen, // length
            0x00,
            0x01, // es_id
            0x00, // stream_priority
            0x04, // descriptor_type
            0x0f + configlen, // length
            0x40, // codec : mpeg4_audio
            0x15, // stream_type
            0x00,
            0x00,
            0x00, // buffer_size
            0x00,
            0x00,
            0x00,
            0x00, // maxBitrate
            0x00,
            0x00,
            0x00,
            0x00, // avgBitrate
            0x05, // descriptor_type
        ]
        .concat([configlen])
        .concat(track.config)
        .concat([0x06, 0x01, 0x02])
        ) // GASpecificConfig)); // length + audio config descriptor
        );
    }
    
    function stts() {
        return box('stts', new Uint8Array([
            0x00, // version
            0x00,
            0x00,
            0x00, // flags
            0x00,
            0x00,
            0x00,
            0x00, // entry_count
        ]));
    }
    
    function stsc() {
        return box('stsc', new Uint8Array([
            0x00, // version
            0x00,
            0x00,
            0x00, // flags
            0x00,
            0x00,
            0x00,
            0x00, // entry_count
        ]));
    }
    
    function stsz() {
        return box('stsz', new Uint8Array([
            0x00, // version
            0x00,
            0x00,
            0x00, // flags
            0x00,
            0x00,
            0x00,
            0x00, // sample_size
            0x00,
            0x00,
            0x00,
            0x00, // sample_count
        ]));
    }
    
    function stco() {
        return box('stco', new Uint8Array([
            0x00, // version
            0x00,
            0x00,
            0x00, // flags
            0x00,
            0x00,
            0x00,
            0x00, // entry_count
        ]));
    }
    
    function mvex(tracks) {
        var i = tracks.length;
        var boxes = [];
        while(i--) {
            boxes[i] = trex(tracks[i]);
        }
        return box.apply(null, ['mvex'].concat(boxes));
    }
    
    function trex(track) {
        var id = track.id;
        return box(
            'trex',
            new Uint8Array([
                0x00, // version 0
                0x00,
                0x00,
                0x00, // flags
                id >> 24,
                (id >> 16) & 0xff,
                (id >> 8) & 0xff,
                id & 0xff, // track_ID
                0x00,
                0x00,
                0x00,
                0x01, // default_sample_description_index
                0x00,
                0x00,
                0x00,
                0x00, // default_sample_duration
                0x00,
                0x00,
                0x00,
                0x00, // default_sample_size
                0x00,
                0x01,
                0x00,
                0x01, // default_sample_flags
            ])
        );
    }
    
    function mfhd(sequenceNumber) {
        return box(
            'mfhd',
            new Uint8Array([
                0x00,
                0x00,
                0x00,
                0x00, // flags
                sequenceNumber >> 24,
                (sequenceNumber >> 16) & 0xff,
                (sequenceNumber >> 8) & 0xff,
                sequenceNumber & 0xff, // sequence_number
            ])
        );
    }
    
    function traf(track, baseMediaDecodeTime) {
        var sampleDependencyTable = sdtp(track);
        var id = track.id;
        return box(
            'traf',
            tfhd(track.id),
            tfdt(baseMediaDecodeTime),
            trun(
                track,
                sampleDependencyTable.length +
                16 + // tfhd
                20 + // tfdt
                8 + // traf header
                16 + // mfhd
                8 + // moof header
                8
            ), // mdat header
            sampleDependencyTable
        );
    }
    
    function tfhd(trackId) {
        return box(
            'tfhd',
            new Uint8Array([
                0x00, // version 0
                0x00,
                0x00,
                0x00, // flags
                trackId >> 24,
                (trackId >> 16) & 0xff,
                (trackId >> 8) & 0xff,
                trackId & 0xff, // track_ID
            ])
        );
    }
    
    function tfdt(baseMediaDecodeTime) {
        var upper = Math.floor(baseMediaDecodeTime / (UINT32_MAX + 1));
        var lower = Math.floor(baseMediaDecodeTime % (UINT32_MAX + 1));
        return box(
            'tfdt',
            new Uint8Array([
                0x01, // version 1
                0x00,
                0x00,
                0x00, // flags
                upper >> 24,
                (upper >> 16) & 0xff,
                (upper >> 8) & 0xff,
                upper & 0xff,
                lower >> 24,
                (lower >> 16) & 0xff,
                (lower >> 8) & 0xff,
                lower & 0xff,
            ])
        );
    }
    
    function sdtp(track) {
        var samples = track.samples || [];
        var bytes = new Uint8Array(4 + samples.length);
        var i;
        var flags;
        // leave the full box header (4 bytes) all zero
        // write the sample table
        for(i = 0; i < samples.length; i++) {
            flags = samples[i].flags;
            bytes[i + 4] = 
                (flags.dependsOn << 4) 
                | (flags.isDependedOn << 2) 
                | flags.hasRedundancy;
        }
        return box('sdtp', bytes);
    }
    
    function trun(track, offset) {
        var samples = track.samples || [];
        var len = samples.length;
        var arraylen = 12 + 16 * len;
        var array = new Uint8Array(arraylen);
        var i;
        var sample;
        var duration;
        var size;
        var flags;
        var cts;
        offset += 8 + arraylen;
        array.set([
            0x00, // version 0
            0x00,
            0x0f,
            0x01, // flags
            (len >>> 24) & 0xff,
            (len >>> 16) & 0xff,
            (len >>> 8) & 0xff,
            len & 0xff, // sample_count
            (offset >>> 24) & 0xff,
            (offset >>> 16) & 0xff,
            (offset >>> 8) & 0xff,
            offset & 0xff, // data_offset
        ], 0);
        for(i = 0; i < len; i++) {
            sample = samples[i];
            duration = sample.duration;
            size = sample.size;
            flags = sample.flags;
            cts = sample.cts;
            array.set([
                (duration >>> 24) & 0xff,
                (duration >>> 16) & 0xff,
                (duration >>> 8) & 0xff,
                duration & 0xff, // sample_duration
                (size >>> 24) & 0xff,
                (size >>> 16) & 0xff,
                (size >>> 8) & 0xff,
                size & 0xff, // sample_size
                (flags.isLeading << 2) | flags.dependsOn,
                (flags.isDependedOn << 6) |
                (flags.hasRedundancy << 4) |
                (flags.paddingValue << 1) |
                flags.isNonSync,
                flags.degradPrio & (0xf0 << 8),
                flags.degradPrio & 0x0f, // sample_flags
                (cts >>> 24) & 0xff,
                (cts >>> 16) & 0xff,
                (cts >>> 8) & 0xff,
                cts & 0xff, // sample_composition_time_offset
            ], 12 + 16 * i);
        }
        return box('trun', array);
    }
    
    this.ftyp = function() {
        // isom
        var majorBrand = new Uint8Array([105, 115, 111, 109]);
        // avc1
        var avc1Brand = new Uint8Array([97, 118, 99, 49]);
        var minorVersion = new Uint8Array([0, 0, 0, 1]);
        return box('ftyp', majorBrand, minorVersion, majorBrand, avc1Brand);
    };
    
    this.moov = function(tracks) {
        var i = tracks.length;
        var boxes = [];
        while(i--) {
            boxes[i] = trak(tracks[i]);
        }
        return box.apply(null, [
            'moov',
            mvhd(tracks[0].timescale, tracks[0].duration)
        ]
        .concat(boxes)
        .concat(mvex(tracks))
        );
    };
    
    this.moof = function(sequenceNumber, baseMediaDecodeTime, track) {
        return box(
            'moof',
            mfhd(sequenceNumber),
            traf(track, baseMediaDecodeTime)
        );
    };
    
    this.mdat = function(data) {
        return box('mdat', data);
    };
}

function AudioRemuxer() {
    function Mp4SampleFlags(isKeyframe) {
        this.isLeading = 0;
        this.isDependedOn = 0;
        this.hasRedundancy = 0;
        this.degradPrio = 0;
        this.dependsOn = 1;
        this.isNonSync = 1;
        this.dependsOn = isKeyframe ? 2 : 1;
        this.isNonSync = isKeyframe ? 0 : 1;
    }

    function Mp4Sample(isKeyframe, duration, size, cts) {
        this.duration = duration;
        this.size = size;
        this.cts = cts;
        this.flags = new Mp4SampleFlags(isKeyframe);
    }

    function normalizePTS(value, reference) {
        if(reference === null) {
            return value;
        }
        var offset;
        if(reference < value) {
            // - 2^33
            offset = -8589934592;
        } else {
            // + 2^33
            offset = 8589934592;
        }
        // PTS is 33bit (from 0 to 2^33 -1) 
        // if diff is bigger than half of the amplitude (2^32)
        // then it means that PTS looping occured. fill the gap
        while(Math.abs(value - reference) > 4294967296) {
            value += offset;
        }
        return value;
    }
    
    var _nextAudioPts = null;
    var adts = new ADTS();
    
    this.remux = function(track, timeOffset) {
        var inputTimeScale = track.inputTimeScale;
        var mp4timeScale = track.samplerate ? track.samplerate : inputTimeScale;
        var scaleFactor = inputTimeScale / mp4timeScale;
        var mp4SampleDuration = 1024;
        var inputSampleDuration = mp4SampleDuration * scaleFactor;
        var outputSamples = [];
        var inputSamples = track.samples;
        var initPTS = inputSamples[0].pts;
        var offset = 0; //8;
        var nextAudioPts = _nextAudioPts || -1;
        var timeOffsetMpegTS = timeOffset * inputTimeScale;
        // compute normalized PTS
        inputSamples.forEach(function(sample) {
            sample.pts = normalizePTS(sample.pts - initPTS, timeOffsetMpegTS);
        });
        // filter out sample with negative PTS that are not playable anyway
        if(nextAudioPts < 0) {
            inputSamples = inputSamples.filter(function (sample) {
                return sample.pts >= 0;
            });
            if(!inputSamples.length) {
                return null;
            }
            // When not seeking, not live, and PTSKnown, 
            // use fragment start as predicted next audio PTS
            nextAudioPts = Math.max(0, timeOffsetMpegTS);
        }
        for(var i = 0, nextPts = nextAudioPts; i < inputSamples.length; i++) {
            inputSamples[i].pts = nextPts;
            nextPts += inputSampleDuration;
        }
        var firstPTS = null;
        var lastPTS = null;
        var mdat;
        var mdatSize = 0;
        var sampleLength = inputSamples.length;
        while(sampleLength--) {
            mdatSize += inputSamples[sampleLength].unit.byteLength;
        }
        for(var _j2 = 0; _j2 < inputSamples.length; _j2++) {
            var audioSample = inputSamples[_j2];
            var unit = audioSample.unit;
            var _pts = audioSample.pts;
            if(lastPTS !== null) {
                // set the duration of the sample to the "real" duration
                var prevSample = outputSamples[_j2 - 1];
                prevSample.duration = Math.round((_pts - lastPTS) / scaleFactor);
            } else {
                // set PTS/DTS to expected PTS/DTS
                _pts = nextAudioPts;
                // remember first PTS of our audioSamples
                firstPTS = _pts;
                if(mdatSize > 0) {
                    //mdatSize += offset;
                    try {
                        mdat = new Uint8Array(mdatSize);
                    } catch(err) {
                        console.log('fail allocating audio mdat ' + mdatSize);
                        return null;
                    }
                    /*var view = new DataView(mdat.buffer);
                    view.setUint32(0, mdatSize);
                    for(var _i = 0; _i < 4; _i++) {
                        mdat[_i + 4] = 'mdat'.charCodeAt(_i);
                    }*/
                } else {
                    // no audio samples
                    return null;
                }
            }
            mdat.set(unit, offset);
            var unitLen = unit.byteLength;
            offset += unitLen;
            outputSamples.push(new Mp4Sample(true, mp4SampleDuration, unitLen, 0));
            lastPTS = _pts;
        }
        if(!outputSamples.length) {
            return null;
        }
        if(!mdat.length) {
            console.log('mdat length must not be zero');
            return null;
        }
        var lastSample = outputSamples[outputSamples.length - 1];
        _nextAudioPts = nextAudioPts = lastPTS + scaleFactor * lastSample.duration;
        track.samples = outputSamples;
        return {
            moof: {
                sequenceNumber: track.sequenceNumber++, 
                baseMediaDecodeTime: firstPTS / scaleFactor
            },
            mdat: {
                buf: mdat
            }
        };
    };
    
    this.appendSample = function(track, data, pts) {
        if(!track.config) {
            var config = adts.getConfig(data, 0);
            track.samplerate = config.samplerate;
            track.channelCount = config.channelCount;
            track.codec = config.codec;
            track.config = config.config;
            track.timescale = config.samplerate;
        }
        var offset;
        var len = data.length;
        for(offset = 0; offset < len - 1; offset++) {
            if(adts.isHeader(data, offset)) {
                break;
            }
        }
        var frameIndex = 0;
        while(offset < len) {
            if(adts.isHeader(data, offset)) {
                if(offset + 5 < len) {
                    var frame = adts.appendSample(track, data, offset, pts, frameIndex);
                    if(frame && !frame.missing) {
                        offset += frame.length;
                        frameIndex++;
                        continue;
                    }
                }
                break;
            } else {
                offset++;
            }
        }
    };
}

function httpGet(url, responseType, callback) {
    var xhr = new XMLHttpRequest();
    xhr.responseType = responseType;
    xhr.onload = function () {
        if(xhr.status === 200) {
            if(responseType == 'text') {
                callback(xhr.responseText);
            } else {
                callback(xhr.response);
            }
        } else {
            callback(null);
        }
    };
    xhr.open('get', url, true);
    xhr.send();
}

function parseM3U8(prefix, content) {
    if(prefix == null) {
        prefix = '';
    }
    var list = [];
    var lines = content.split(/\r|\n|\r\n/);
    for(var i = 0; i < lines.length; i++) {
        if(lines[i].indexOf('#EXT-X-ENDLIST') === 0) {
            break;
        }
        if(lines[i].indexOf('#EXTINF') === 0) {
            var start = lines[i].indexOf(':');
            var end = lines[i].indexOf(',');
            var value = lines[i].substring(start + 1, end);
            list.push({
                duration: parseFloat(value),
                url: prefix + lines[++i]
            });
        }
    }
    return list;
}

var prefix = 'http://localhost:9494/resources/m3u8/';
var url = prefix + 'index.m3u8';
var audioBufs = [];
var mediaSource = new MediaSource();
var sourceBuffer;
var tsdemuxer = new TSDemuxer();
var fmp4 = new FMP4();
var audioRemuxer = new AudioRemuxer();

function playTSAudio(tsList, index, track) {
    if(index >= tsList.length) {
        return;
    }
    track.samples = [];
    httpGet(tsList[index].url, 'arraybuffer', function(buf) {
        tsdemuxer.demux(new Uint8Array(buf), function(data) {
            if(data.type !== 'audio') {
                return;
            }
            audioRemuxer.appendSample(track, data.es, data.pts);
        });
        if(!sourceBuffer) {
            var mime = 'audio/mp4; codecs="' + track.codec + '"';
            sourceBuffer = mediaSource.addSourceBuffer(mime);
            var ftyp = fmp4.ftyp();
            var moov = fmp4.moov([track]);
            audioBufs.push(ftyp);
            audioBufs.push(moov);
        }
        var result = audioRemuxer.remux(track, 0);
        var moof = fmp4.moof(
            result.moof.sequenceNumber, 
            result.moof.baseMediaDecodeTime, 
            track
        );
        var mdat = fmp4.mdat(result.mdat.buf);
        audioBufs.push(moof);
        audioBufs.push(mdat);
        playTSAudio(tsList, index + 1, track);
    });
}

httpGet(url, 'text', function(content) {
    var tsList = parseM3U8(prefix, content);
    var duration = 0;
    for(var i = 0; i < tsList.length; i++) {
        duration += tsList[i].duration;
    }
    var track = {
        duration: duration,
        id: 2,
        inputTimeScale: 90000,
        isAAC: true,
        samples: [],
        sequenceNumber: 2,
        type: 'audio'
    };
    var audio = document.createElement('audio');
    document.body.appendChild(audio);
    audio.controls = 'controls';
    audio.src = URL.createObjectURL(mediaSource);
    audio.play();
    playTSAudio(tsList, 0, track);
    var timer = setInterval(function() {
        if(sourceBuffer && !sourceBuffer.updating && audioBufs.length > 0) {
            sourceBuffer.appendBuffer(audioBufs.shift());
        }
    }, 100);
});

















































































