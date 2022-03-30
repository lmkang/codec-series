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
        var bytes = ;
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
        var width = track.width;
        var height = track.height;
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
            return MP4.box('minf', vmhd(), dinf(), stbl(track));
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
    
    function vmhd() {
        return box('vmhd', new Uint8Array([
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
            0x00, // opcolor
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
            box('stts', MP4.STTS), 
            box('stsc', MP4.STSC), 
            box('stsz', MP4.STSZ), 
            box('stco', MP4.STCO)
        );
    }
    
    function stsd(track) {
        if(track.type === 'audio') {
            if(!track.isAAC && track.codec === 'mp3') {
                return box(MP4.types.stsd, MP4.STSD, MP4.mp3(track));
            }
            return MP4.box(MP4.types.stsd, MP4.STSD, MP4.mp4a(track));
        } else {
            return MP4.box(MP4.types.stsd, MP4.STSD, MP4.avc1(track));
        }
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
    
    
}
















































































